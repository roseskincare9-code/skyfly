// The backup workflow downloads the full backup with the server's backup key (SKYFLY_BACKUP_KEY), not
// anyone's password. The key opens that one download only; a wrong key is refused and logged; without a
// key configured, the download still needs the platform owner's sign-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, signUp } from './helpers.js';
import { makeConfig } from './helpers.js';
import { createApp } from '../src/app.js';

const KEY = 'k'.repeat(20) + 'Q7xP2mV9rT4wL8nZ5bY3';
const { pool, app } = setup({ backupKey: KEY });
const noKey = createApp({ pool, config: makeConfig({ backupKey: null }) });
const body = (r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); };

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@skyfly.test' });
});
after(() => pool.end());

test('the right key downloads the full backup, logged as made with the backup key', async () => {
  const res = await request(app).get('/admin/backup.json').set('Authorization', `Bearer ${KEY}`).buffer(true).parse(body).expect(200);
  assert.equal(JSON.parse(res.body).format, 'skyfly-backup-v1');
  const { rows: [a] } = await pool.query("SELECT details FROM audit_log WHERE action = 'admin.backup_downloaded' ORDER BY id DESC LIMIT 1");
  assert.equal(a.details.via, 'backup key');
});

test('a wrong key is refused and logged; no key goes to the sign-in page', async () => {
  await request(app).get('/admin/backup.json').set('Authorization', 'Bearer wrong-key-wrong-key-wrong-key-123').expect(401);
  const { rows } = await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.backup_key_refused'");
  assert.equal(rows.length, 1);
  await request(app).get('/admin/backup.json').expect(302).expect('Location', '/login');
});

test('the key opens nothing else', async () => {
  for (const path of ['/admin', '/admin/system', '/admin/settings', '/']) {
    const res = await request(app).get(path).set('Authorization', `Bearer ${KEY}`);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.location, '/login', path);
  }
});

test('without a key configured on the server, a key is never accepted', async () => {
  await request(noKey).get('/admin/backup.json').set('Authorization', `Bearer ${KEY}`).expect(302).expect('Location', '/login');
});
