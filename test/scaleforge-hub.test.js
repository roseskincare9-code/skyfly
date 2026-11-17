// ScaleForge Business Hub: created once as a NEW business with its own ID and workspace, owned by the
// existing Super Admin account (which keeps its other businesses and global access); never merged with
// ScaleForge business growth or Skill Forge; never re-created. The public pages show the WhatsApp support link.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase } from './helpers.js';
import { ensureScaleForgeHub } from '../src/services/setup.js';

const { pool, app } = setup({});
const quiet = { log: () => {}, error: () => {} };
let admin; let growth; let skill;
before(async () => {
  await resetDatabase(pool);
  ({ rows: [admin] } = await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ('Laroseskincare3@gmail.com', 'x', 'Owner', true) RETURNING id"));
  ({ rows: [growth] } = await pool.query("INSERT INTO businesses (owner_id, name, slug) VALUES ($1, 'ScaleForge business growth', 'scaleforge-business-growth') RETURNING id", [admin.id]));
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [growth.id, admin.id]);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@skillforge.test', 'x', 'Skill') RETURNING id");
  ({ rows: [skill] } = await pool.query("INSERT INTO businesses (owner_id, name, slug) VALUES ($1, 'Skill Forge', 'skill-forge') RETURNING id", [u.id]));
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [skill.id, u.id]);
});
after(() => pool.end());

test('creates ScaleForge Business Hub once, as its own business owned by the Super Admin; nothing else changes', async () => {
  const before = (await pool.query('SELECT id, name, slug, owner_id FROM businesses ORDER BY id')).rows;
  const r = await ensureScaleForgeHub(pool, quiet);
  assert.equal(r.status, 'created');
  const { rows: [hub] } = await pool.query('SELECT * FROM businesses WHERE id = $1', [r.businessId]);
  assert.deepEqual([hub.name, hub.slug, hub.currency, hub.subscription_status, Number(hub.owner_id)], ['ScaleForge Business Hub', 'scaleforge-business-hub', 'NGN', 'internal', Number(admin.id)]);
  assert.ok(![growth.id, skill.id].includes(hub.id), 'a new business ID');
  const { rows: members } = await pool.query('SELECT user_id, role FROM business_members WHERE business_id = $1', [hub.id]);
  assert.deepEqual(members.map((m) => [Number(m.user_id), m.role]), [[Number(admin.id), 'owner']]);
  // Existing businesses unchanged; the Super Admin keeps its other business and its global access.
  assert.deepEqual((await pool.query('SELECT id, name, slug, owner_id FROM businesses WHERE id <> $1 ORDER BY id', [hub.id])).rows, before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM business_members WHERE user_id = $1', [admin.id])).rows[0].n, 2);
  assert.equal((await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [admin.id])).rows[0].is_platform_admin, true);
  // Never twice, even after a rename.
  await pool.query("UPDATE businesses SET name = 'Hub renamed', slug = 'hub-renamed' WHERE id = $1", [hub.id]);
  assert.equal((await ensureScaleForgeHub(pool, quiet)).status, 'exists');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM businesses WHERE name ILIKE '%hub%'")).rows[0].n, 1);
});

test('the public pages show the WhatsApp support link (0904 920 6695 → wa.me/2349049206695)', async () => {
  for (const path of ['/', '/pricing']) {
    const r = await request(app).get(path).expect(200);
    assert.match(r.text, /href="https:\/\/wa\.me\/2349049206695\?text=[^"]+"/, path);
    assert.match(r.text, /0904 920 6695/, path);
  }
});
