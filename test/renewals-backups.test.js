// Renewal manager additions and backup status: payment method status (never card details), alerts at
// 14/7/3/0 days and at once for a payment problem, recording a renewal with evidence (a domain is never
// shown as renewed until the registry agrees), and backup/restore results reported by the backup job with
// the server's backup key (failure alert and email; no session needed, nothing else accepted).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { serviceSummary, remindInfra, remindBackups, backupHealth } from '../src/services/infra.js';

const KEY = 'k'.repeat(48);
const realFetch = globalThis.fetch;
const mailed = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) { mailed.push(JSON.parse(opts.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return realFetch(url, opts);
};
const notifyEmail = { provider: 'resend', apiKey: 're_test_not_real_000', fromEmail: 'no-reply@skyfly.test', fromName: 'Skyfly' };
const app = setup({ allowedOrigins: [], notifyEmail, backupKey: KEY });
const pool = app.pool;
const server = app.app.listen(0);
let admin; let owner;
const day = (n, from = Date.now()) => new Date(from + n * 864e5).toISOString().slice(0, 10);
const adminPost = async (path, form) => { const _csrf = await csrfToken(admin, '/admin/infrastructure'); return admin.post(path).type('form').send({ _csrf, ...form }); };
const report = (body, key = KEY) => request(server).post('/admin/backup-report').set('Authorization', `Bearer ${key}`).send(body);

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(server, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  owner = await signUp(server, { name: 'Owner', email: 'owner@shop.test', business: 'Owner Shop' });
});
after(async () => { server.close(); globalThis.fetch = realFetch; await pool.end(); });

describe('renewal manager', () => {
  test('alerts step through 14, 7, 3 days and the renewal date, once each; a payment problem alerts at once', async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO infra_services (name, provider, category, price_minor, billing_frequency, next_payment_on, payment_status, payment_method_status)
       VALUES ('Hosting', 'Render', 'hosting', 700, 'monthly', $1, 'due', 'on_file') RETURNING id`, [day(14)]);
    const base = Date.now();
    const steps = [];
    for (const n of [0, 0, 7, 11, 14]) { // 14 days before (twice: sent once), 7, 3, then the date itself
      steps.push(...(await remindInfra(pool, { notifyEmail }, { now: new Date(base + n * 864e5) })).map((r) => r.threshold));
    }
    assert.deepEqual(steps, ['14d', '7d', '3d', '0d']);
    assert.match(mailed.at(-1).subject, /Hosting \(Render\): renews today/);
    // A declined payment method: emailed as soon as it is saved, without waiting for the scheduled job.
    mailed.length = 0;
    assert.equal((await adminPost(`/admin/infrastructure/${s.id}`, { name: 'Hosting', provider: 'Render', category: 'hosting', price: '7', billing_frequency: 'monthly', next_payment_on: day(14), payment_status: 'due', payment_method_status: 'failed' })).status, 302);
    assert.equal(mailed.length, 1);
    assert.match(mailed[0].subject, /^ACTION NEEDED: Hosting \(Render\): payment problem/);
    const page = await admin.get('/admin').expect(200);
    assert.match(page.text, /data-infra-alert[\s\S]*payment method was declined/);
    const infra = await admin.get('/admin/infrastructure').expect(200);
    assert.match(infra.text, /data-payment-method[\s\S]*Declined \/ failed[\s\S]*no card details stored/);
  });

  test('payment method summaries: expired/declined act, missing watches; never card numbers', () => {
    assert.equal(serviceSummary({ billing_frequency: 'monthly', payment_method_status: 'expired' }).level, 'act');
    assert.equal(serviceSummary({ billing_frequency: 'monthly', payment_method_status: 'missing' }).level, 'watch');
    assert.equal(serviceSummary({ billing_frequency: 'monthly', payment_method_status: 'on_file' }).level, 'ok');
  });

  test('recording a renewal needs evidence and moves the date on; a domain stays "not confirmed" until the registry agrees', async () => {
    await pool.query("INSERT INTO platform_domains (domain, registered, registry_expires_at, rdap_checked_at) VALUES ('getskyfly.com', true, '2027-10-30T15:12:07Z', now())");
    const { rows: [d] } = await pool.query(
      `INSERT INTO infra_services (name, provider, category, billing_frequency, expires_on, payment_status, payment_method_status)
       VALUES ('getskyfly.com domain', 'Cloudflare Registrar', 'domain', 'yearly', '2027-10-30', 'paid', 'unknown') RETURNING id`);
    let page = await admin.get('/admin/infrastructure').expect(200);
    assert.match(page.text, /registry confirms 2027-10-30/);
    // No evidence, future payment date, or a new date not after it: refused.
    assert.equal((await adminPost(`/admin/infrastructure/${d.id}/renewal`, { renewed_on: day(0), new_date: '2028-10-30', evidence: '' })).status, 400);
    assert.equal((await adminPost(`/admin/infrastructure/${d.id}/renewal`, { renewed_on: day(3), new_date: '2028-10-30', evidence: 'INV-1' })).status, 400);
    assert.equal((await adminPost(`/admin/infrastructure/${d.id}/renewal`, { renewed_on: day(0), new_date: day(0), evidence: 'INV-1' })).status, 400);
    // Recorded with evidence, but the registry still shows 2027: marked as not confirmed.
    const r = await adminPost(`/admin/infrastructure/${d.id}/renewal`, { renewed_on: day(0), new_date: '2028-10-30', evidence: 'CF-INV-12345', amount: '10.44' });
    assert.equal(r.headers.location, '/admin/infrastructure?done=renewed_unconfirmed');
    page = await admin.get('/admin/infrastructure').expect(200);
    assert.match(page.text, /registry shows 2027-10-30/);
    assert.match(page.text, /not confirmed by the registry yet/);
    assert.match(page.text, /data-renewals[\s\S]*2027-10-30 → <strong>2028-10-30<\/strong>[\s\S]*CF-INV-12345/);
    // The registry's date moves (the 12-hourly check): now confirmed.
    await pool.query("UPDATE platform_domains SET registry_expires_at = '2028-10-30T15:12:07Z' WHERE domain = 'getskyfly.com'");
    page = await admin.get('/admin/infrastructure').expect(200);
    assert.match(page.text, /registry confirms 2028-10-30/);
    assert.doesNotMatch(page.text, /not confirmed by the registry yet/);
    const { rows: [audit] } = await pool.query("SELECT details FROM audit_log WHERE action = 'admin.infra_renewal_recorded'");
    assert.equal(audit.details.registry_confirmed, false);
    // A business owner cannot record anything.
    const _csrf = await csrfToken(owner, '/login');
    assert.equal((await owner.post(`/admin/infrastructure/${d.id}/renewal`).type('form').send({ _csrf, renewed_on: day(0), new_date: '2029-01-01', evidence: 'x123' })).status, 404);
  });

  test('a non-domain service: the next payment date moves on and payment becomes Paid', async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO infra_services (name, provider, category, price_minor, billing_frequency, next_payment_on, payment_status, payment_method_status)
       VALUES ('Database', 'Render', 'database', 1930, 'monthly', $1, 'due', 'on_file') RETURNING id`, [day(2)]);
    assert.equal((await adminPost(`/admin/infrastructure/${s.id}/renewal`, { renewed_on: day(0), new_date: day(30), evidence: 'Render invoice 2026-12' })).headers.location, '/admin/infrastructure?done=renewed');
    const { rows: [after] } = await pool.query('SELECT next_payment_on, last_paid_on, payment_status, invoice_ref FROM infra_services WHERE id = $1', [s.id]);
    assert.deepEqual([String(after.next_payment_on), String(after.last_paid_on), after.payment_status, after.invoice_ref], [day(30), day(0), 'paid', 'Render invoice 2026-12']);
  });
});

describe('backup status', () => {
  test('the backup job reports with the backup key only; wrong or missing key refused; bad input refused', async () => {
    assert.equal((await report({ kind: 'backup', status: 'success' }, 'wrong'.repeat(10))).status, 404);
    assert.equal((await request(server).post('/admin/backup-report').send({ kind: 'backup', status: 'success' })).status, 404);
    assert.equal((await report({ kind: 'nope', status: 'success' })).status, 400);
    assert.equal((await report({ kind: 'backup', status: 'success', tables: -1 })).status, 400);
    const ok = await report({ kind: 'backup', status: 'success', run_id: '42', run_url: 'https://github.com/o/r/actions/runs/42', size_bytes: 6344992, sha256: 'a'.repeat(64), tables: 37, total_rows: 2300 });
    assert.equal(ok.status, 201);
    const h = await backupHealth(pool);
    assert.equal(h.lastOk.total_rows, 2300);
    assert.deepEqual(h.alerts, []);
  });

  test('a failed backup alerts the dashboard and emails Super Admins at once; a restore test is recorded', async () => {
    mailed.length = 0;
    const r = await report({ kind: 'backup', status: 'failed', run_id: '43', run_url: 'https://github.com/o/r/actions/runs/43', detail: 'Backup download: HTTP 503' });
    assert.equal(r.status, 201);
    assert.match(r.body.notified, /Sent to 1 Super Admin/);
    assert.equal(mailed.length, 1);
    assert.match(mailed[0].subject, /ACTION NEEDED: Database backup FAILED/);
    assert.deepEqual([mailed[0].to].flat(), ['founder@skyfly.test']);
    const dash = await admin.get('/admin').expect(200);
    assert.match(dash.text, /data-backup-alert[\s\S]*The last backup failed[\s\S]*HTTP 503/);
    assert.equal((await report({ kind: 'restore_test', status: 'success', run_id: '44', tables: 37, total_rows: 2300 })).status, 201);
    const sys = await admin.get('/admin/system').expect(200);
    assert.match(sys.text, /data-backup-run="failed"/);
    assert.match(sys.text, /Restore test/);
    // The next successful backup clears the alert.
    await report({ kind: 'backup', status: 'success', run_id: '45' });
    assert.doesNotMatch((await admin.get('/admin').expect(200)).text, /The last backup failed/);
    // Owners never see it.
    assert.equal((await owner.get('/admin/system')).status, 404);
  });

  test('no successful backup for 36 hours: alert and one email a day', async () => {
    await pool.query("UPDATE backup_runs SET created_at = now() - interval '40 hours'");
    mailed.length = 0;
    const first = await remindBackups(pool, { notifyEmail });
    assert.ok(first);
    assert.equal(await remindBackups(pool, { notifyEmail }), null);
    assert.equal(mailed.length, 1);
    assert.match(mailed[0].subject, /no successful Skyfly backup for 4\d hours/);
    assert.match((await admin.get('/admin').expect(200)).text, /newest successful backup is 4\d hours old/);
  });

  test('the database plan warning on System status follows the record (gone once there is no expiry)', async () => {
    await pool.query("INSERT INTO infra_services (name, provider, category, billing_frequency, expires_on, payment_status) VALUES ('DB', 'Render', 'database', 'free', '2026-11-14', 'free')");
    assert.match((await admin.get('/admin/system').expect(200)).text, /The database plan expires on/);
    await pool.query("UPDATE infra_services SET expires_on = NULL WHERE name = 'DB'");
    assert.doesNotMatch((await admin.get('/admin/system').expect(200)).text, /The database plan expires on/);
  });
});
