// Central Google Sheets: connections per business, default sheet inherited by new pages,
// page overrides, column checks, automatic repair of an empty sheet, business isolation, export.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { resetDatabase, csrfToken, signUp, ORIGIN, makeConfig, testDatabaseUrl } from './helpers.js';
import { startSheetDbMock } from './sheetdb-mock.js';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { syncDue, recheckConnections, SKYFLY_TAB, SHEET_COLUMNS } from '../src/services/sheets.js';

const mock = await startSheetDbMock();
const key = randomBytes(32);
const config = makeConfig({ encryptionKey: key });
const pool = createPool(testDatabaseUrl(), false);
const app = createApp({ pool, config });
const sync = async () => {
  await pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE sheet_sync_status IN ('pending', 'failed')");
  return syncDue(pool, { key });
};
let owner;
let biz;
let base;
let n = 0;

const order = (landingPage, name, product = 'package-1') => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage, idempotencyKey: `gs-test-key-${String(n += 1).padStart(6, '0')}`,
  customer: { name, phone: '08051234567', address: '3 Test Close, Ikeja', state: 'Lagos' },
  items: [{ product, quantity: 1 }],
});
const orderRow = async (ref) => (await pool.query('SELECT * FROM orders WHERE reference = $1', [ref])).rows[0];
const conn = async (name) => (await pool.query('SELECT * FROM sheet_connections WHERE name = $1', [name])).rows[0];
async function post(agent, path, body = {}) {
  const _csrf = await csrfToken(agent, `${base}/google-sheets`);
  return agent.post(`${base}${path}`).type('form').send({ _csrf, ...body });
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  biz = await seedLarose(pool, 'owner@larose.test');
  base = `/businesses/${biz}`;
  await pool.query('UPDATE businesses SET sheet_backup_url = NULL WHERE id = $1', [biz]);
});
after(async () => { await pool.end(); mock.close(); });

describe('connecting spreadsheets centrally', () => {
  test('Google Sheets is in the sidebar and the old address redirects', async () => {
    const page = await owner.get(`${base}/google-sheets`).expect(200);
    assert.match(page.text, new RegExp(`href="${base}/google-sheets"[^>]*>[\\s\\S]{0,400}Google Sheets`));
    assert.match(page.text, /No spreadsheet connected yet/);
    const old = await owner.get(`${base}/sheet-backup?check=1`).expect(301);
    assert.equal(old.headers.location, `${base}/google-sheets?check=1`);
  });

  test('the first spreadsheet becomes the default; the URL is stored encrypted and never shown again', async () => {
    const res = await post(owner, '/google-sheets/connections', { name: 'Main orders', api_url: mock.url('mainsheet01'), spreadsheet_url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const c = await conn('Main orders');
    assert.ok(!c.api_url_enc.includes('mainsheet01'));
    assert.equal(c.check_status, 'ok', 'columns checked on connect');
    assert.match(c.check_detail, /All 12 of Skyfly's 12 columns match/);
    assert.equal((await pool.query('SELECT default_sheet_connection_id AS d FROM businesses WHERE id = $1', [biz])).rows[0].d, c.id);
    const page = await owner.get(`${base}/google-sheets`).expect(200);
    assert.ok(!page.text.includes('mainsheet01'), 'the API URL is not shown');
    assert.match(page.text, /…et01/);
    assert.match(page.text, /Open spreadsheet ↗/);
    assert.match(page.text, /Default<\/span>/);
  });

  test('the same sheet cannot be connected twice', async () => {
    const res = await post(owner, '/google-sheets/connections', { name: 'Again', api_url: mock.url('mainsheet01') });
    assert.equal(res.status, 409);
  });

  test('a sheet missing required columns is reported with the exact columns', async () => {
    mock.tabs.set('partial01|', { columns: ['timestamp', 'fullName', 'phone'], rows: [] });
    await post(owner, '/google-sheets/connections', { name: 'Partial', api_url: mock.url('partial01') });
    const c = await conn('Partial');
    assert.equal(c.check_status, 'needs_columns');
    assert.match(c.check_detail, /missing the columns package, source/);
  });
});

describe('routing orders from all landing pages', () => {
  test('orders from the existing page and from a newly added page go to the default sheet automatically', async () => {
    const res = await order('larosenigeria', 'Default Sheet Customer');
    assert.equal(res.status, 201);
    await sync();
    assert.equal((await orderRow(res.body.reference)).sheet_sync_status, 'synced');
    assert.equal(mock.rows('mainsheet01').filter((r) => r.source.includes(res.body.reference)).length, 1);

    // A page registered later has no sheet settings of its own: it inherits the default.
    const _csrf = await csrfToken(owner, `${base}/landing-pages/new`);
    const { rows: products } = await pool.query("SELECT id FROM products WHERE business_id = $1 AND code = 'package-1'", [biz]);
    await owner.post(`${base}/landing-pages`).type('form').send({ _csrf, name: 'October promo', slug: 'larose-october', status: 'active', products: String(products[0].id) }).expect(302);
    const list = await owner.get(`${base}/landing-pages`).expect(200);
    assert.match(list.text, /Main orders \(default\)/);
    const second = await order('larose-october', 'New Page Customer');
    assert.equal(second.status, 201);
    await sync();
    const o = await orderRow(second.body.reference);
    assert.equal(o.sheet_sync_status, 'synced');
    assert.equal(o.sheet_connection_id, (await conn('Main orders')).id);
    assert.match(mock.rows('mainsheet01').at(-1).source, /^October promo \| Skyfly /);
    const c = await conn('Main orders');
    assert.ok(c.last_success_at, 'last successful copy recorded');
  });

  test('a page with its own sheet sends only its orders there', async () => {
    await post(owner, '/google-sheets/connections', { name: 'Promo report', api_url: mock.url('promosheet1') });
    const promo = await conn('Promo report');
    const { rows: [page] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larose-october'");
    const res = await post(owner, `/google-sheets/pages/${page.id}`, { sheet_connection_id: String(promo.id) });
    assert.equal(res.status, 302);
    const a = await order('larose-october', 'Promo Sheet Customer');
    const b = await order('larosenigeria', 'Main Sheet Customer');
    await sync();
    assert.equal(mock.rows('promosheet1').filter((r) => r.source.includes(a.body.reference)).length, 1);
    assert.equal(mock.rows('mainsheet01').filter((r) => r.source.includes(a.body.reference)).length, 0);
    assert.equal(mock.rows('mainsheet01').filter((r) => r.source.includes(b.body.reference)).length, 1);
    const form = await owner.get(`${base}/landing-pages/${page.id}`).expect(200);
    assert.match(form.text, /<strong>Promo report<\/strong> \(this page&#39;s own sheet\)/);
    // Back to the default.
    await post(owner, `/google-sheets/pages/${page.id}`, { sheet_connection_id: '' });
    assert.equal((await pool.query('SELECT sheet_connection_id FROM landing_pages WHERE id = $1', [page.id])).rows[0].sheet_connection_id, null);
  });

  test('changing the default applies to every page without its own sheet', async () => {
    const promo = await conn('Promo report');
    await post(owner, `/google-sheets/connections/${promo.id}/default`);
    const res = await order('larosenigeria', 'New Default Customer');
    await sync();
    assert.equal(mock.rows('promosheet1').filter((r) => r.source.includes(res.body.reference)).length, 1);
    await post(owner, `/google-sheets/connections/${(await conn('Main orders')).id}/default`);
  });
});

describe('an empty spreadsheet (no column row)', () => {
  test('Skyfly adds a "Skyfly Orders" tab with its columns once, then the failed copies go through, without duplicates', async () => {
    mock.makeEmpty('emptysheet1');
    await post(owner, '/google-sheets/connections', { name: 'Empty sheet', api_url: mock.url('emptysheet1'), make_default: 'on' });
    let c = await conn('Empty sheet');
    assert.equal(c.check_status, 'needs_columns');
    const page = await owner.get(`${base}/google-sheets`).expect(200);
    assert.match(page.text, /The sheet needs Skyfly's column names in row 1/);
    assert.match(page.text, new RegExp(SHEET_COLUMNS.join('  ')));

    const res = await order('larosenigeria', 'Empty Sheet Customer');
    await sync();
    const o = await orderRow(res.body.reference);
    assert.equal(o.sheet_sync_status, 'synced', o.sheet_sync_error);
    c = await conn('Empty sheet');
    assert.equal(c.sheet_tab, SKYFLY_TAB);
    assert.equal(c.check_status, 'ok');
    assert.ok(c.auto_setup_at);
    assert.equal(mock.rows('emptysheet1', SKYFLY_TAB).length, 1);
    await sync();
    assert.equal(mock.rows('emptysheet1', SKYFLY_TAB).length, 1, 'not written twice');
  });

  test('when SheetDB refuses to add a tab, the order is safe, the reason is shown and the owner gets one clear fix', async () => {
    mock.state.allowCreateTab = false;
    mock.makeEmpty('emptysheet2');
    await post(owner, '/google-sheets/connections', { name: 'Locked sheet', api_url: mock.url('emptysheet2'), make_default: 'on' });
    const res = await order('larosenigeria', 'Locked Sheet Customer');
    await sync();
    let o = await orderRow(res.body.reference);
    assert.equal(o.sheet_sync_status, 'failed');
    assert.match(o.sheet_sync_error, /The sheet is empty \(no column names in row 1\)\. Skyfly could not add a "Skyfly Orders" tab/);
    const tries = mock.state.requests.filter((r) => r.startsWith('POST /api/v1/emptysheet2/sheet')).length;
    await pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE id = $1", [o.id]);
    await sync();
    assert.equal(mock.state.requests.filter((r) => r.startsWith('POST /api/v1/emptysheet2/sheet')).length, tries, 'the automatic fix is tried once only');

    assert.match(o.sheet_sync_error, /plan does not allow adding tabs\. Type the column names into row 1/);

    // The owner types the column row in Google Sheets. Nothing else: Skyfly notices and sends the waiting order.
    mock.tabs.get('emptysheet2|').columns = [...SHEET_COLUMNS];
    await pool.query("UPDATE sheet_connections SET checked_at = now() - interval '11 minutes' WHERE name = 'Locked sheet'");
    assert.equal(await recheckConnections(pool, key), 1);
    assert.equal((await conn('Locked sheet')).check_status, 'ok');
    assert.equal((await orderRow(res.body.reference)).sheet_sync_status, 'pending', 'queued again right away');
    await syncDue(pool, { key });
    o = await orderRow(res.body.reference);
    assert.equal(o.sheet_sync_status, 'synced');
    assert.equal(mock.rows('emptysheet2').length, 1);
    mock.state.allowCreateTab = true;
    await post(owner, `/google-sheets/connections/${(await conn('Main orders')).id}/default`);
  });
});

describe('business isolation', () => {
  let other;
  let otherBiz;
  before(async () => {
    other = await signUp(app, { email: 'other@shop.test' });
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'other@shop.test'");
    otherBiz = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
    const p = (await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'other-item', 'Other item', 500000) RETURNING id", [otherBiz])).rows[0].id;
    const lp = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'other-page', 'Other page', 'active') RETURNING id", [otherBiz])).rows[0].id;
    await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp, p]);
  });

  test('another business cannot see, use or change this business\'s spreadsheets', async () => {
    const main = await conn('Main orders');
    await other.get(`${base}/google-sheets`).expect(404);
    const otherBase = `/businesses/${otherBiz}`;
    const _csrf = await csrfToken(other, `${otherBase}/google-sheets`);
    const { rows: [page] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'other-page'");
    const res = await other.post(`${otherBase}/google-sheets/pages/${page.id}`).type('form').send({ _csrf, sheet_connection_id: String(main.id) });
    assert.equal(res.status, 400);
    await other.post(`${otherBase}/google-sheets/connections/${main.id}/default`).type('form').send({ _csrf }).expect(404);
    await other.get(`${otherBase}/google-sheets/export.csv?connection=${main.id}`).expect(404);
    // The database refuses it too.
    await assert.rejects(pool.query('UPDATE businesses SET default_sheet_connection_id = $1 WHERE id = $2', [main.id, otherBiz]), /businesses_default_sheet_fk/);
    await assert.rejects(pool.query('UPDATE landing_pages SET sheet_connection_id = $1 WHERE id = $2', [main.id, page.id]), /landing_pages_sheet_fk/);
  });

  test('orders of a business without a spreadsheet are never sent to another business\'s sheet', async () => {
    const before = mock.rows('mainsheet01').length;
    const res = await order('other-page', 'Other Shop Customer', 'other-item');
    assert.equal(res.status, 201);
    await sync();
    assert.equal((await orderRow(res.body.reference)).sheet_sync_status, 'skipped');
    assert.equal(mock.rows('mainsheet01').length, before);
    for (const [, t] of mock.tabs) assert.ok(!t.rows.some((r) => String(r.fullName).includes('Other Shop')));
  });
});

describe('export and maintenance', () => {
  test('orders download in the sheet\'s own columns, for one spreadsheet', async () => {
    const main = await conn('Main orders');
    const res = await owner.get(`${base}/google-sheets/export.csv?connection=${main.id}`).expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], [...SHEET_COLUMNS, 'copyStatus'].join(','));
    assert.ok(lines.some((l) => l.includes('Default Sheet Customer')));
    assert.ok(!lines.some((l) => l.includes('Promo Sheet Customer')), 'only that sheet\'s orders');
    const all = await owner.get(`${base}/google-sheets/export.csv`).expect(200);
    assert.ok(all.text.includes('Promo Sheet Customer'));
  });

  test('values that would run as spreadsheet formulas are kept as text', async () => {
    const res = await order('larosenigeria', '=HYPERLINK("http://evil.example","x")');
    await sync();
    const row = mock.rows('mainsheet01').find((r) => r.source.includes(res.body.reference));
    assert.equal(row.fullName, '\'=HYPERLINK("http://evil.example","x")');
    assert.equal(row.phone, '+2348051234567', 'phone numbers unchanged');
  });

  test('removing a connection moves its pages back to the default; the status page still works', async () => {
    const promo = await conn('Promo report');
    const { rows: [page] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larose-october'");
    await post(owner, `/google-sheets/pages/${page.id}`, { sheet_connection_id: String(promo.id) });
    const res = await post(owner, `/google-sheets/connections/${promo.id}/delete`);
    assert.equal(res.status, 302);
    assert.equal(await conn('Promo report'), undefined);
    assert.equal((await pool.query('SELECT sheet_connection_id FROM landing_pages WHERE id = $1', [page.id])).rows[0].sheet_connection_id, null);
    const status = await owner.get(`${base}/google-sheets`).expect(200);
    assert.match(status.text, /Last successful copy/);
    const o = await owner.get(`${base}/orders/${(await orderRow((await pool.query("SELECT reference FROM orders WHERE customer_name = 'Default Sheet Customer'")).rows[0].reference)).id}`).expect(200);
    assert.match(o.text, /Spreadsheet: <a href="[^"]+">Main orders<\/a> · <a href="https:\/\/docs\.google\.com/);
  });
});
