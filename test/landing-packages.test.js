// The prepared landing-page packages import cleanly with Skyfly's own importer.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importUpload } from '../src/hosting/importer.js';

const lp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../landing-pages');
const SLUGS = ['larose-nigeria', 'larose-uk', 'scaleforge-nigeria', 'scaleforge-london', 'ai-skincare-academy'];
const results = {};

before(async () => {
  execFileSync('python3', [path.join(lp, 'prepare.py')]);
  for (const slug of SLUGS) {
    results[slug] = {
      upload: await importUpload({ buffer: readFileSync(path.join(lp, 'dist', `${slug}.zip`)), originalname: `${slug}.zip` }),
      manifest: JSON.parse(readFileSync(path.join(lp, 'packages', slug, 'skyfly-manifest.json'), 'utf8')),
      page: readFileSync(path.join(lp, 'packages', slug, 'index.html'), 'utf8'),
    };
  }
});

test('every package imports with no missing files and lists every file in its manifest', () => {
  for (const slug of SLUGS) {
    const { upload, manifest } = results[slug];
    assert.equal(upload.entryPath, 'index.html', slug);
    assert.equal(upload.report.missingCount, 0, `${slug}: ${upload.report.missing}`);
    assert.deepEqual(upload.report.rootAbsolute, [], slug);
    assert.deepEqual(upload.files.map((f) => f.path).sort(), manifest.assets.map((a) => a.file).sort(), slug);
    assert.ok(upload.totalBytes < 25 * 1024 * 1024, slug);
  }
});

test('both Larose shop pages are connected to Skyfly, keep the Google Sheet backup and keep their Meta Pixel', () => {
  for (const [slug, key] of [['larose-nigeria', 'larosenigeria'], ['larose-uk', 'larose-uk']]) {
    const { upload, page, manifest } = results[slug];
    assert.equal(upload.report.connected, true, slug);
    assert.ok(!upload.report.warnings.some((w) => /not connected/.test(w)), slug);
    assert.deepEqual(upload.report.pixels.map((p) => p.id), ['1357015185691765'], slug);
    assert.match(page, new RegExp(`const SKYFLY_PAGE="${key}"`));
    assert.match(page, /const SKYFLY_API="https:\/\/skyfly-gybf\.onrender\.com"/);
    assert.match(page, /const SKYFLY_SHEET_FALLBACK=true/);
    assert.match(page, /sheetdb\.io\/api\/v1\/m111fq96ve953/);
    assert.equal(manifest.orderFlow.current, 'skyfly+google-sheet-backup');
  }
});

test('no order button sends customers to WhatsApp; WhatsApp stays only as contact on 09049206695', () => {
  for (const slug of ['larose-nigeria', 'larose-uk']) {
    const { page } = results[slug];
    assert.doesNotMatch(page, /WhatsApp Me<\/a>|Order on WhatsApp|Contact Me on WhatsApp/, slug);
    for (const m of page.matchAll(/wa\.me\/(\d+)/g)) assert.equal(m[1], '2349049206695', slug);
  }
});

test('UK products in the page match the manifest (codes and £ prices)', () => {
  const { page, manifest } = results['larose-uk'];
  for (const p of manifest.orderFlow.products) assert.match(page, new RegExp(`data-product="${p.code}" data-price="${p.price}"`));
  assert.equal(manifest.orderFlow.currency, 'GBP');
});

test('no package contains private keys or tokens', () => {
  for (const slug of SLUGS) {
    const { page, manifest } = results[slug];
    const text = page + JSON.stringify(manifest);
    assert.doesNotMatch(text, /EAA[A-Za-z0-9]{20,}|sk_(live|test)_|Bearer\s+[A-Za-z0-9]|sky_[A-Za-z0-9]{10,}|access_token\s*[:=]\s*['"][^'"]{8,}/, slug);
  }
});
