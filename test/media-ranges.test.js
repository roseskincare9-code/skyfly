// Byte-range serving for stored media (landing-page videos and the Creative Library): Safari on iPhone/iPad
// only plays <video> when Range requests get 206 Partial Content. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { sendWithRanges } from '../src/lib/http.js';

const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const app = express();
app.get('/v', (req, res) => { res.type('video/mp4'); sendWithRanges(req, res, body); });
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const url = `http://127.0.0.1:${server.address().port}/v`;
test.after(() => server.close());

test('no Range: whole file, advertises byte ranges', async () => {
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal((await r.arrayBuffer()).byteLength, 1000);
});
test('Safari\'s first probe (bytes=0-1) and a middle range get 206 with the exact bytes', async () => {
  let r = await fetch(url, { headers: { range: 'bytes=0-1' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-1/1000');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 1]);
  r = await fetch(url, { headers: { range: 'bytes=500-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 500-999/1000');
  assert.equal((await r.arrayBuffer()).byteLength, 500);
});
test('suffix range (last N bytes) and an end beyond the file are clamped', async () => {
  let r = await fetch(url, { headers: { range: 'bytes=-100' } });
  assert.equal(r.headers.get('content-range'), 'bytes 900-999/1000');
  r = await fetch(url, { headers: { range: 'bytes=990-5000' } });
  assert.equal(r.headers.get('content-range'), 'bytes 990-999/1000');
});
test('a range past the end is 416; a malformed one gets the whole file', async () => {
  let r = await fetch(url, { headers: { range: 'bytes=2000-3000' } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */1000');
  r = await fetch(url, { headers: { range: 'items=0-5' } });
  assert.equal(r.status, 200);
});
