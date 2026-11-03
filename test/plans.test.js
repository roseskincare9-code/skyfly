// Subscription plans (Business Pro ₦199,000/month, Agency VIP ₦399,000/month): set by the Super Admin,
// shown to the business's own members only; platform figures on the Super Admin overview; the read-only
// tenancy map at start-up masks emails and flags unusual memberships.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { logTenancyMap } from '../src/services/tenancyReport.js';

const { pool, app: expressApp } = setup({ allowedOrigins: [] });
const app = expressApp.listen(0);
let admin; let ownerA; let ownerB; let bizA; let bizB;

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { name: 'Platform Owner', email: 'admin@skyfly.test' }); // first account: Super Admin (development)
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Owner A', email: 'a@shop-a.test', business: 'Shop A' });
  ownerB = await signUp(app, { name: 'Owner B', email: 'b@shop-b.test', business: 'Shop B' });
  bizA = (await pool.query("SELECT id FROM businesses WHERE name = 'Shop A'")).rows[0].id;
  bizB = (await pool.query("SELECT id FROM businesses WHERE name = 'Shop B'")).rows[0].id;
});
after(async () => { app.close(); await pool.end(); });

const setPlan = async (biz, fields) => {
  const _csrf = await csrfToken(admin, `/admin/businesses/${biz}`);
  return admin.post(`/admin/businesses/${biz}/subscription`).type('form')
    .send({ _csrf, subscription_status: 'active', subscription_currency: 'NGN', price: '', started_on: '2026-11-01', expires_on: '2026-12-01', ...fields });
};

test('choosing a plan sets its monthly price (Business Pro ₦199,000, Agency VIP ₦399,000)', async () => {
  assert.equal((await setPlan(bizA, { plan: 'business_pro' })).status, 302);
  assert.equal((await setPlan(bizB, { plan: 'agency_vip' })).status, 302);
  const { rows } = await pool.query('SELECT id, plan, subscription_price_minor, subscription_currency FROM businesses WHERE id = ANY($1) ORDER BY id', [[bizA, bizB]]);
  assert.deepEqual(rows.map((r) => [r.plan, Number(r.subscription_price_minor), r.subscription_currency]), [['business_pro', 19900000, 'NGN'], ['agency_vip', 39900000, 'NGN']]);
  const audit = await pool.query("SELECT details FROM audit_log WHERE action = 'subscription.updated' AND business_id = $1", [bizA]);
  assert.equal(audit.rows.at(-1).details.after.plan, 'business_pro');
});

test('a custom price is kept; an unknown plan is refused; "no plan" clears it', async () => {
  assert.equal((await setPlan(bizA, { plan: 'business_pro', price: '150,000' })).status, 302);
  assert.equal(Number((await pool.query('SELECT subscription_price_minor FROM businesses WHERE id = $1', [bizA])).rows[0].subscription_price_minor), 15000000);
  assert.equal((await setPlan(bizA, { plan: 'gold' })).status, 400);
  assert.equal((await setPlan(bizA, { plan: '' })).status, 302);
  assert.equal((await pool.query('SELECT plan FROM businesses WHERE id = $1', [bizA])).rows[0].plan, null);
  await setPlan(bizA, { plan: 'business_pro' });
});

test("each owner sees only their own plan; another business's subscription page is not found", async () => {
  const a = await ownerA.get(`/businesses/${bizA}/subscription`).expect(200);
  assert.match(a.text, /data-plan>Business Pro</);
  assert.doesNotMatch(a.text, /Agency VIP/);
  const b = await ownerB.get(`/businesses/${bizB}/subscription`).expect(200);
  assert.match(b.text, /data-plan>Agency VIP</);
  assert.equal((await ownerA.get(`/businesses/${bizB}/subscription`)).status, 404);
  assert.equal((await ownerB.get(`/businesses/${bizA}/subscription`)).status, 404);
  assert.equal((await ownerA.post(`/businesses/${bizA}/subscription`).type('form').send({ _csrf: await csrfToken(ownerA, `/businesses/${bizA}`), plan: 'agency_vip' })).status >= 400, true, 'owners cannot change their own plan');
  assert.equal((await pool.query('SELECT plan FROM businesses WHERE id = $1', [bizA])).rows[0].plan, 'business_pro');
});

test('the Super Admin overview shows platform figures and each business\'s plan', async () => {
  const r = await admin.get('/admin').expect(200);
  assert.match(r.text, /data-platform-analytics/);
  assert.match(r.text, /Business Pro/);
  assert.match(r.text, /data-plan>Agency VIP</);
});

test('the tenancy map lists every business with masked members and flags unusual cases', async () => {
  await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('lonely@x.test', 'x', 'Lonely')");
  const lines = []; const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try { await logTenancyMap(pool); } finally { console.log = orig; }
  const text = lines.join('\n');
  assert.match(text, /BEGIN \d+ businesses/);
  assert.match(text, new RegExp(`business #${bizA} .*members: owner:a…@shop-a\\.test`));
  assert.match(text, /SUPER ADMIN account #\d+ ad…@skyfly\.test/);
  assert.match(text, /END accounts with no workspace: \d+ \(.*lo…@x\.test/);
  assert.doesNotMatch(text, /a@shop-a\.test|admin@skyfly\.test/, 'emails are masked');
});

test('plan limits: set in Platform settings, applied when a plan is chosen, team invitations stop at the plan size', async () => {
  let _csrf = await csrfToken(admin, '/admin/settings');
  await admin.post('/admin/settings').type('form').send({ _csrf, client_signup: 'open', trial_days: '7', limit_business_pro_landing_pages: '6', limit_business_pro_team_members: '2', limit_agency_vip_landing_pages: '' }).expect(302);
  _csrf = await csrfToken(admin, '/admin/settings');
  assert.equal((await admin.post('/admin/settings').type('form').send({ _csrf, client_signup: 'open', trial_days: '7', limit_agency_vip_team_members: 'many' })).status, 400);
  const { rows: [s] } = await pool.query("SELECT value FROM platform_settings WHERE key = 'plan_limits'");
  assert.deepEqual(s.value.business_pro, { landing_pages: 6, team_members: 2 });
  // Agency VIP has no limits set: choosing it changes nothing; Business Pro brings 6 pages.
  await setPlan(bizB, { plan: 'agency_vip' });
  await setPlan(bizA, { plan: '' });
  await setPlan(bizA, { plan: 'business_pro' });
  const { rows } = await pool.query('SELECT id, max_landing_pages FROM businesses WHERE id = ANY($1) ORDER BY id', [[bizA, bizB]]);
  assert.deepEqual(rows.map((r) => r.max_landing_pages), [6, 4]);
  // Team of 2 (owner + 1): one invitation fits, the next is refused.
  const invite = async (email) => { const c = await csrfToken(ownerA, `/businesses/${bizA}/team`); return ownerA.post(`/businesses/${bizA}/team/invite`).type('form').send({ _csrf: c, email, role: 'staff' }); };
  assert.equal((await invite('staff1@shop-a.test')).status, 200);
  const refused = await invite('staff2@shop-a.test');
  assert.equal(refused.status, 403);
  assert.match(refused.text, /up to 2 team members/);
});
