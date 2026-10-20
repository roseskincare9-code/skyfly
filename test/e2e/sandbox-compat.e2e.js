// What imported pages can and cannot do on the Skyfly address (/p/<slug>/, browser sandbox),
// measured in Chromium. Prints a table; fails only if something Skyfly promises stops working.
//   npm run test:e2e:compat
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import yazl from 'yazl';
import request from 'supertest';
import { createPool } from '../../src/db.js';
import { resetDatabase, testDatabaseUrl, csrfToken, signUp } from '../helpers.js';
import { createApp } from '../../src/app.js';
import { makeConfig } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'http://localhost:3161';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4/58BCBj+M4AZDP/BAADq0Qf5o8sMZgAAAABJRU5ErkJggg==', 'base64');
const FONT = (await import('node:fs')).readFileSync(path.join(root, 'src/static/fonts/dm-sans-v17-latin.woff2'));
const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="css/site.css">
<script type="module" src="js/mod.js"></script><script src="js/classic.js"></script></head>
<body><h1 id="h">Compat</h1><img id="rel" src="img/a.png"><img id="abs" src="/img/a.png"><form id="f" action="https://example.com/x" method="post"><input name="a"></form><div data-skyfly-checkout></div>
<script>
window.R = {};
try { localStorage.setItem('k','1'); R.localStorage = 'works'; } catch (e) { R.localStorage = 'blocked'; }
try { sessionStorage.setItem('k','1'); R.sessionStorage = 'works'; } catch (e) { R.sessionStorage = 'blocked'; }
try { document.cookie = 'k=1'; R.cookies = document.cookie.includes('k=1') ? 'works' : 'blocked'; } catch (e) { R.cookies = 'blocked'; }
try { indexedDB.open('x'); R.indexedDB = 'works'; } catch (e) { R.indexedDB = 'blocked'; }
R.serviceWorker = 'serviceWorker' in navigator ? 'present' : 'blocked';
R.origin = window.origin;
fetch('data/info.json').then(r => r.json()).then(j => { R.fetchJson = j.ok ? 'works' : 'broken'; }, () => { R.fetchJson = 'blocked'; });
fetch('${BASE}/healthz', { credentials: 'include' }).then(r => r.text()).then(() => { R.dashboardRead = 'READABLE'; }, () => { R.dashboardRead = 'blocked'; });
</script></body></html>`;

function zip(entries) {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.from(c), n);
    const chunks = []; z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))); z.end();
  });
}

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const app = createApp({ pool, config: makeConfig({ publicBaseUrl: BASE, pagesBaseUrl: '' }) });
const owner = await signUp(app, { email: 'owner@compat.test' });
const _csrf = await csrfToken(owner, '/?all=1');
const biz = (await owner.post('/businesses').type('form').send({ _csrf, name: 'Compat' })).headers.location.match(/businesses\/(\d+)/)[1];
const buf = await zip({
  'index.html': HTML,
  'css/site.css': `@font-face{font-family:T;src:url(../fonts/t.woff2) format('woff2')} h1{font-family:T;color:rgb(1, 2, 3)} body{background:url(../img/a.png)}`,
  'js/mod.js': 'window.moduleRan = true;', 'js/classic.js': 'window.classicRan = true;',
  'img/a.png': PNG, 'fonts/t.woff2': FONT, 'data/info.json': '{"ok":true}',
});
const c2 = await csrfToken(owner, `/businesses/${biz}/landing-pages`);
const up = await owner.post(`/businesses/${biz}/landing-pages/upload`).field('_csrf', c2).field('name', 'compat').attach('file', buf, 'compat.zip');
const pageId = up.headers.location.match(/landing-pages\/(\d+)/)[1];
const v = (await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [pageId])).rows[0].id;
// Published pages need something to order (publishing is refused otherwise).
const item = (await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'compat-item', 'Compat item', 100000) RETURNING id", [biz])).rows[0].id;
await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [pageId, item]);
const c3 = await csrfToken(owner, `/businesses/${biz}/landing-pages`);
await owner.post(`/businesses/${biz}/landing-pages/${pageId}/publish`).type('form').send({ _csrf: c3, version_id: String(v) });
await pool.end();

const server = spawn('node', ['src/server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: '3161', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'compat', PUBLIC_BASE_URL: BASE, PAGES_BASE_URL: '', SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64') } });
for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
const browser = await chromium.launch();
let failed = false;
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/p/compat/`);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    ...window.R, moduleScript: window.moduleRan ? 'works' : 'blocked', classicScript: window.classicRan ? 'works' : 'blocked',
    relativeImage: document.getElementById('rel').naturalWidth > 0 ? 'works' : 'broken',
    rootAbsoluteImage: document.getElementById('abs').naturalWidth > 0 ? 'works' : 'broken',
    css: getComputedStyle(document.getElementById('h')).color === 'rgb(1, 2, 3)' ? 'works' : 'broken',
    webFont: document.fonts.check('16px T') && [...document.fonts].some((f) => f.family === 'T' && f.status === 'loaded') ? 'works' : 'not loaded',
  }));
  console.log('Feature on /p/<slug>/ (sandbox)   Result');
  for (const [k, val] of Object.entries(r)) console.log(`  ${k.padEnd(30)} ${val}`);
  const must = { classicScript: 'works', moduleScript: 'works', relativeImage: 'works', css: 'works', webFont: 'works', fetchJson: 'works', dashboardRead: 'blocked', origin: 'null' };
  for (const [k, want] of Object.entries(must)) if (r[k] !== want) { failed = true; console.log(`FAIL  ${k}: expected ${want}, got ${r[k]}`); }
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? '\nCompatibility check FAILED' : '\nCompatibility check passed');
process.exit(failed ? 1 : 0);
