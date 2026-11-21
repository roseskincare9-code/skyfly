// The dashboard's Content-Security-Policy (helmet defaults: script-src-attr 'none') blocks inline event
// handlers, so an onclick/onchange/onsubmit attribute silently does nothing in browsers: a dropdown that never
// switches, a confirmation that never asks. No dashboard view may use one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('src/views');
const files = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? files(path.join(d, f)) : f.endsWith('.ejs') ? [path.join(d, f)] : []));

test('no dashboard view uses inline event handlers (blocked by the CSP)', () => {
  const bad = [];
  for (const f of files(dir)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\son[a-z]+\s*=\s*["']/i.test(line)) bad.push(`${path.relative(dir, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
