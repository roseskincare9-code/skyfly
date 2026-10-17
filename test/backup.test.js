// Full backup download (platform owner only) and restore into a separate, empty database
// as a non-superuser (like Render). Every table and row must come back identical.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN, openClientSignup, testDatabaseUrl } from './helpers.js';
import { createPool } from '../src/db.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { TABLE_ORDER, restoreBackup, uncoveredTables } from '../src/services/backup.js';

const { pool, app } = setup();
const restoreUrl = testDatabaseUrl().replace(/\/[^/]+$/, '/skyfly_restore_test');
const target = createPool(restoreUrl, false);
let admin;
let backup;

before(async () => {
  await resetDatabase(pool);
  await resetDatabase(target);
  admin = await signUp(app, { email: 'owner@larose.test' });
  const biz = await seedLarose(pool, 'owner@larose.test');
  await openClientSignup(pool);
  for (let i = 1; i <= 3; i += 1) {
    await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: `backup-test-key-${String(i).padStart(6, '0')}`,
      customer: { name: `Backup Customer ${i}`, phone: '08051234567', address: '3 Test Close, Ikeja', email: `c${i}@example.test` },
      items: [{ product: 'package-2', quantity: i }],
    }).expect(201);
  }
  // A hosted page (binary files, and the page -> published version reference).
  const _csrf = await csrfToken(admin, `/businesses/${biz}/landing-pages`);
  const up = await admin.post(`/businesses/${biz}/landing-pages/upload`).field('_csrf', _csrf).field('name', 'Hosted')
    .attach('file', Buffer.from('<!doctype html><title>Hosted</title><h1>Hosted ✨</h1>'), 'index.html').expect(302);
  const pageId = up.headers.location.match(/landing-pages\/(\d+)/)[1];
  const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [pageId]);
  await pool.query('UPDATE landing_pages SET published_version_id = $1 WHERE id = $2', [v.id, pageId]);
  // Business default sheet (business -> sheet connection reference).
  await pool.query("UPDATE businesses SET sheet_backup_url = 'https://sheetdb.io/api/v1/m111fq96ve953' WHERE id = $1", [biz]);
  await (await import('../src/services/sheets.js')).adoptLegacyUrls(pool, null);
});
after(async () => { await pool.end(); await target.end(); });

test('every data table is in the backup', async () => {
  assert.deepEqual(await uncoveredTables(pool), []);
});

test('only the platform owner can download it; the download is logged', async () => {
  const client = await signUp(app, { email: 'client@shop.test' });
  await client.get('/admin/backup.json').expect(404);
  await request(app).get('/admin/backup.json').expect(302);
  const res = await admin.get('/admin/backup.json').buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); }).expect(200);
  assert.match(res.headers['content-disposition'], /attachment; filename="skyfly-backup-/);
  backup = JSON.parse(res.body);
  assert.equal(backup.format, 'skyfly-backup-v1');
  assert.ok(backup.migrations.includes('013_email_automations.sql'));
  assert.equal(backup.tables.orders.rows.length, 3);
  const { rows } = await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.backup_downloaded'");
  assert.equal(rows.length, 1);
  const page = await admin.get('/admin/system').expect(200);
  assert.match(page.text, /Download full backup/);
  assert.match(page.text, /<code>orders<\/code><\/td><td>3</);
});

test('the backup restores into an empty database exactly, and numbering continues', async () => {
  const counts = await restoreBackup(target, backup);
  for (const t of TABLE_ORDER) {
    const [a, b] = await Promise.all([pool, target].map(async (db) => (await db.query(`SELECT * FROM ${t} ORDER BY 1`)).rows));
    // Rows written after the download (the audit entry for it) are the only difference.
    const src = t === 'audit_log' ? a.filter((r) => r.action !== 'admin.backup_downloaded') : a;
    assert.equal(b.length, src.length, `${t}: row count`);
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(src)), `${t}: identical rows`);
    assert.equal(counts[t], backup.tables[t].rows.length);
  }
  const { rows: [blob] } = await target.query('SELECT data FROM page_blobs LIMIT 1');
  assert.match(blob.data.toString('utf8'), /Hosted ✨/);
  const { rows: [b] } = await target.query("SELECT default_sheet_connection_id FROM businesses WHERE slug = 'larose-nigeria'");
  assert.ok(b.default_sheet_connection_id);
  const { rows: [next] } = await target.query("INSERT INTO platform_settings (key, value) VALUES ('restore_check', '1') RETURNING key");
  assert.equal(next.key, 'restore_check');
  const { rows: [o] } = await target.query('SELECT max(id) AS m FROM orders');
  const { rows: [seq] } = await target.query("SELECT nextval(pg_get_serial_sequence('orders', 'id')) AS n");
  assert.ok(Number(seq.n) > Number(o.m), 'new ids do not clash with restored ones');
});

test('restoring never overwrites a database that already has data', async () => {
  await assert.rejects(restoreBackup(target, backup), /already has businesses/);
  await assert.rejects(restoreBackup(pool, backup), /already has businesses/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 3);
});
