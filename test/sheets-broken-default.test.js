// The Google Sheets page warns when the business's default spreadsheet is not working and orders are
// waiting, and offers to use a working connection instead (one click). Nothing is written to any sheet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetDatabase, signUp, openClientSignup } from './helpers.js';

const { pool, app } = setup({});
let owner; let other; let biz; let otherBiz; let broken; let working;
const conn = (b, name, status, extra = {}) => pool.query(
  `INSERT INTO sheet_connections (business_id, name, api_url_enc, api_url_hash, api_hint, check_status, check_detail, last_error)
   VALUES ($1, $2, 'enc', $3, 'hint', $4, $5, $6) RETURNING id`,
  [b, name, `hash-${name}`, status, extra.detail ?? null, extra.error ?? null]).then((r) => r.rows[0].id);

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  owner = await signUp(app, { name: 'Owner', email: 'o@shop.test', business: 'Shop One' });
  other = await signUp(app, { name: 'Other', email: 'x@shop.test', business: 'Shop Two' });
  [biz, otherBiz] = await Promise.all(['Shop One', 'Shop Two'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  broken = await conn(biz, 'Old SheetDB', 'needs_columns', { detail: 'The sheet is empty: row 1 has no column names, so SheetDB refuses every new row.', error: 'Google Sheet (SheetDB) answered HTTP 429: Request limit exceeded.' });
  working = await conn(biz, 'Orders (Google)', 'ok');
  await pool.query('UPDATE businesses SET default_sheet_connection_id = $1 WHERE id = $2', [broken, biz]);
  await pool.query(
    `INSERT INTO orders (business_id, reference, customer_name, phone, address, total_minor, currency, idempotency_key, sheet_sync_status, sheet_connection_id, access_token, request_fingerprint)
     VALUES ($1, 'SO-AAA1111', 'Ada Test', '+2348030000000', '5 Ring Road, Ibadan', 100, 'NGN', 'key-aaa-0123456789', 'failed', $2, 'tok-aaa-0123456789abcdef', 'fp-a'), ($1, 'SO-BBB2222', 'Bola Test', '+2348030000001', '5 Ring Road, Ibadan', 100, 'NGN', 'key-bbb-0123456789', 'failed', $2, 'tok-bbb-0123456789abcdef', 'fp-b')`, [biz, broken]);
});
after(() => pool.end());

test('a broken default with waiting orders is flagged, with a one-click switch to the working spreadsheet', async () => {
  const page = await owner.get(`/businesses/${biz}/google-sheets`).expect(200);
  assert.match(page.text, /data-default-broken/);
  assert.match(page.text, /2 orders could not be copied: the default spreadsheet "Old SheetDB" is not working/);
  assert.match(page.text, /row 1 has no column names/); assert.match(page.text, /HTTP 429/);
  assert.match(page.text, new RegExp(`action="/businesses/${biz}/google-sheets/connections/${working}/default"[\\s\\S]{0,200}data-use-working="${working}"`));
  assert.match(page.text, /The orders are safe in Skyfly/);
});

test('no warning for a business whose default works, or that has nothing waiting; never another business\'s sheets', async () => {
  const page = await other.get(`/businesses/${otherBiz}/google-sheets`).expect(200);
  assert.doesNotMatch(page.text, /data-default-broken|Old SheetDB|Orders \(Google\)/);
  await pool.query("UPDATE orders SET sheet_sync_status = 'synced' WHERE business_id = $1", [biz]);
  assert.doesNotMatch((await owner.get(`/businesses/${biz}/google-sheets`).expect(200)).text, /data-default-broken/);
});
