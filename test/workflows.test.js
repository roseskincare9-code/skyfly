// Workflow files: none may serialise ALL secrets or variables (toJSON(secrets) / toJSON(vars)). GitHub then
// holds every run for approval ("action_required", no job ever starts): this silently stopped the one-step
// signup activation from running between 11 and 26 November 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../.github/workflows/', import.meta.url);

test('no workflow reads every secret or variable at once', () => {
  for (const f of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const expressions = readFileSync(new URL(f, DIR), 'utf8').match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    for (const e of expressions) assert.ok(!/toJSON\(\s*(secrets|vars)\s*\)/i.test(e), `${f}: ${e}`);
  }
});

test('the onboarding readiness check always disables the live-test sign-in it enabled', () => {
  const y = readFileSync(new URL('e2e-live-onboarding.yml', DIR), 'utf8');
  assert.match(y, /e2e-login\.mjs enable/);
  assert.match(y, /if: always\(\)\s*\n\s*run: node scripts\/e2e-login\.mjs disable/);
});
