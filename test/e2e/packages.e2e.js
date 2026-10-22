// End-to-end test of the prepared landing-page packages (landing-pages/packages/*),
// served from another origin and submitting to a local Skyfly, in Chromium.
//
//   npm run test:e2e:packages     (builds the packages first)
// Requires a local *_test database in .env.test. Screenshots go to test/e2e/screenshots/packages/.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { seedLarose } from '../../src/scripts/seed-larose.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lp = path.join(root, 'landing-pages');
const shots = path.join(root, 'test/e2e/screenshots/packages');
mkdirSync(shots, { recursive: true });
const SKYFLY = 'http://localhost:3110';
const ORIGIN = 'http://127.0.0.1:3300';
const LIVE_API = 'https://skyfly-gybf.onrender.com';
const SLUGS = ['larose-nigeria', 'larose-uk', 'scaleforge-nigeria', 'scaleforge-london', 'ai-skincare-academy'];

execFileSync('python3', [path.join(lp, 'prepare.py')], { stdio: 'inherit' });

const TYPES = { html: 'text/html; charset=utf-8', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
// The original page with only its base64 images swapped for the package's files: must look identical.
function imagesOnly(slug) {
  const manifest = JSON.parse(readFileSync(path.join(lp, 'packages', slug, 'skyfly-manifest.json'), 'utf8'));
  const bySha = new Map(manifest.assets.filter((a) => a.sha256).map((a) => [a.sha256, a.file]));
  return readFileSync(path.join(lp, 'sources', slug, 'original.html'), 'utf8')
    .replace(/data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)/g, (m, t, b64) => {
      const file = bySha.get(createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'));
      assert.ok(file, `${slug}: an embedded image has no extracted file`);
      return file;
    });
}
const site = createServer((req, res) => {
  const [, kind, slug, ...rest] = new URL(req.url, ORIGIN).pathname.split('/');
  const file = rest.join('/') || 'index.html';
  if (!SLUGS.includes(slug)) return res.writeHead(404).end();
  let body;
  if (kind === 'original' && file === 'index.html') body = readFileSync(path.join(lp, 'sources', slug, 'original.html'));
  else if (kind === 'images-only' && file === 'index.html') body = imagesOnly(slug);
  else if (['pkg', 'images-only'].includes(kind)) {
    const p = path.join(lp, 'packages', slug, file);
    if (!p.startsWith(path.join(lp, 'packages', slug)) || !existsSync(p)) return res.writeHead(404).end();
    body = readFileSync(p);
    // Point the page at this local Skyfly instead of the live service.
    if (file === 'index.html') body = body.toString('utf8').replaceAll(LIVE_API, SKYFLY);
  } else return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1)] || 'application/octet-stream' });
  res.end(body);
}).listen(3300);

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: '3110', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret', ALLOWED_ORIGINS: ORIGIN, PUBLIC_BASE_URL: SKYFLY },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${SKYFLY}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

// Owner, Larose Nigeria (as "Set up Larose" does) and Larose UK (as the IMPORT.md steps do).
const { rows: [owner] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@larose.test', 'x', 'Owner') RETURNING id");
await seedLarose(pool, 'owner@larose.test');
const { rows: [uk] } = await pool.query(
  "INSERT INTO businesses (owner_id, name, slug, currency, whatsapp_number, order_prefix) VALUES ($1, 'Larose UK', 'larose-uk', 'GBP', '+2349049206695', 'LU') RETURNING id", [owner.id]);
const ukProducts = JSON.parse(readFileSync(path.join(lp, 'packages/larose-uk/skyfly-manifest.json'), 'utf8')).orderFlow.products;
for (const [i, p] of ukProducts.entries()) {
  await pool.query('INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, $2, $3, $4, $5)', [uk.id, p.code, p.name, p.price * 100, i + 1]);
}
await pool.query(`INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'larose-uk', 'Larose UK', '${ORIGIN}/pkg/larose-uk/', 'active')`, [uk.id]);
await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT lp.id, p.id FROM landing_pages lp JOIN products p ON p.business_id = lp.business_id WHERE lp.slug = 'larose-uk'");

const browser = await chromium.launch();
let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const orders = async (slug) => (await pool.query(
  `SELECT o.*, (SELECT json_agg(json_build_object('code', p.code, 'qty', i.quantity)) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS items
     FROM orders o JOIN landing_pages lp ON lp.id = o.landing_page_id WHERE lp.slug = $1 ORDER BY o.id`, [slug])).rows;

try {
  await step('every package looks exactly like its original page (images moved out of the HTML, pixel-identical)', async () => {
    for (const slug of SLUGS) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
        const ctx = await browser.newContext({ viewport });
        await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
        const shot = async (kind) => {
          const p = await ctx.newPage();
          await p.clock.install({ time: new Date('2026-10-15T12:00:00Z') });
          await p.goto(`${ORIGIN}/${kind}/${slug}/`, { waitUntil: 'load' });
          await p.clock.pauseAt(new Date('2026-10-15T12:00:05Z'));
          await p.evaluate(() => document.querySelectorAll('.fi').forEach((e) => e.classList.add('vis')));
          const png = await p.screenshot({ fullPage: true, animations: 'disabled' });
          await p.close();
          return png;
        };
        const [a, b] = [await shot('original'), await shot('images-only')];
        assert.ok(a.equals(b), `${slug} at ${viewport.width}px differs after moving images out`);
        await ctx.close();
      }
    }
  });

  await step('final packages render on mobile and desktop (screenshots saved for review)', async () => {
    for (const slug of SLUGS) {
      for (const [label, opts] of [['mobile', devices['iPhone 13']], ['desktop', { viewport: { width: 1280, height: 900 } }]]) {
        const ctx = await browser.newContext(opts);
        await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
        const p = await ctx.newPage();
        const broken = [];
        p.on('response', (r) => { if (r.url().startsWith(ORIGIN) && r.status() >= 400) broken.push(r.url()); });
        await p.goto(`${ORIGIN}/pkg/${slug}/`, { waitUntil: 'load' });
        assert.deepEqual(broken, [], `${slug}: missing files`);
        const sideScroll = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(sideScroll <= 1, `${slug} scrolls sideways on ${label} (${sideScroll}px)`);
        await p.screenshot({ path: path.join(shots, `${slug}-${label}.png`) });
        await ctx.close();
      }
    }
  });

  // Order flows on the two shop pages.
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  const sheetRows = [];
  let sheetDown = false;
  await ctx.route('https://sheetdb.io/**', (route) => {
    if (sheetDown) return route.abort('connectionrefused');
    sheetRows.push(JSON.parse(route.request().postData()).data);
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{"created":1}' });
  });
  const whatsappOpened = [];
  ctx.on('request', (r) => { if (/wa\.me|api\.whatsapp/.test(r.url())) whatsappOpened.push(r.url()); });
  const shop = await ctx.newPage();

  await step('UK: order buttons lead to the order form, not WhatsApp; contact links stay', async () => {
    await shop.goto(`${ORIGIN}/pkg/larose-uk/`);
    const href = await shop.getAttribute('a:has-text("Yes! I Want This — Order Now")', 'href');
    assert.equal(href, '#order');
    assert.ok(await shop.locator('a[href^="https://wa.me/2349049206695"]:has-text("Chat With Us on WhatsApp")').count() === 1);
    assert.equal(await shop.textContent('#sb'), '📲 Place My Order →');
  });

  await step('UK: missing details are shown on the form and nothing is sent', async () => {
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible' });
    assert.match(await shop.textContent('#skyErr'), /Please fill in all required fields/);
    assert.equal((await orders('larose-uk')).length, 0);
    assert.equal(sheetRows.length, 0);
  });

  const fillUk = async (name) => {
    await shop.goto(`${ORIGIN}/pkg/larose-uk/?utm_source=tiktok&utm_campaign=uk-e2e`);
    await shop.click('text=Order Package 2');
    await shop.fill('#fn', name);
    await shop.fill('#addr', '221B Baker Street, London');
    await shop.fill('#ph', '07700 900123');
    await shop.fill('#em', 'amara@example.co.uk');
    await shop.selectOption('#qty', '2');
    await shop.fill('#nt', 'NW1 6XE, after 5pm');
    const summary = await shop.textContent('#skySum');
    assert.match(summary, /Package 2 – The Power Glow \(2kg Soap \+ Free Glow Oil\) × 2/);
    assert.match(summary, /Total: £240 · our team confirms and takes payment/);
  };

  let ukRef;
  await step("UK: a double-tapped order is saved once in Skyfly (GBP, +44 phone), queued for Skyfly's Google Sheet copy, then confirmed", async () => {
    await fillUk('Amara Okafor');
    // Two taps in the same instant, before the button can disable itself.
    await Promise.all([shop.waitForURL(/\/o\/LU-/, { timeout: 30000 }), shop.evaluate(() => { doSub(); doSub(); })]);
    const rows = await orders('larose-uk');
    assert.equal(rows.length, 1, 'exactly one order');
    const o = rows[0];
    ukRef = o.reference;
    assert.equal(o.currency, 'GBP');
    assert.equal(Number(o.total_minor), 240 * 100);
    assert.equal(o.phone, '+447700900123');
    assert.deepEqual(o.items, [{ code: 'uk-package-2', qty: 2 }]);
    assert.equal(o.utm_source, 'tiktok');
    assert.equal(o.utm_campaign, 'uk-e2e');
    assert.equal(sheetRows.length, 0, 'the page does not write the sheet for a saved order');
    assert.equal(o.sheet_sync_status, 'pending', 'queued for Skyfly\'s own Google Sheet copy');
    assert.match(await shop.textContent('body'), new RegExp(ukRef));
    assert.match(await shop.textContent('body'), /£240/);
  });

  await step('UK: if Skyfly cannot be reached, the order still reaches the Google Sheet (marked NOT IN SKYFLY) and the original success box shows', async () => {
    await shop.route(`${SKYFLY}/api/public/orders`, (route) => route.abort('connectionrefused'));
    await fillUk('Fallback Customer');
    await shop.click('#sb');
    await shop.waitForSelector('#sb2', { state: 'visible', timeout: 20000 });
    assert.equal(sheetRows.length, 1, "only the fallback row");
    assert.match(sheetRows[0].source, /NOT IN SKYFLY/);
    assert.equal((await orders('larose-uk')).length, 1, 'no extra Skyfly order');
  });

  await step('UK: if Skyfly and the Sheet are both down, the customer sees an error and keeps their details', async () => {
    sheetDown = true;
    await fillUk('Both Down');
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible', timeout: 40000 });
    assert.match(await shop.textContent('#skyErr'), /couldn't reach our order system|could not/i);
    assert.equal(await shop.inputValue('#fn'), 'Both Down');
    sheetDown = false;
    await shop.unroute(`${SKYFLY}/api/public/orders`);
  });

  await step('Nigeria: order buttons lead to the form; an order is saved once in Skyfly (Skyfly copies it to the Sheet)', async () => {
    const before = sheetRows.length;
    await shop.goto(`${ORIGIN}/pkg/larose-nigeria/`);
    assert.equal(await shop.getAttribute('a:has-text("Order Now") >> nth=0', 'href'), '#order');
    await shop.click('text=Order Power Glow');
    await shop.fill('#fn', 'Ngozi Adeyemi');
    await shop.fill('#addr', '14 Admiralty Way, Lekki Phase 1');
    await shop.fill('#ph', '08051234567');
    await shop.selectOption('#st', 'Lagos');
    await Promise.all([shop.waitForURL(/\/o\/LR-/, { timeout: 30000 }), shop.click('#sb')]);
    const rows = await orders('larosenigeria');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].total_minor), 58000 * 100);
    assert.equal(sheetRows.length, before, 'saved in Skyfly: no browser sheet row');
  });

  await step('no step opened WhatsApp', async () => assert.deepEqual(whatsappOpened, []));
  await ctx.close();
  console.log(`\nPackages E2E passed: ${passed} steps`);
} finally {
  await browser.close();
  server.kill();
  site.close();
  await pool.end();
}
