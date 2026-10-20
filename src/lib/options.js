// Product options (sizes, colours, bundles…), each value with an optional price difference.
// Typed by the owner one group per line:  "Size: 30ml, 50ml (+5000)"  "Colour: Gold, Silver"
import { parseMajorToMinor } from './money.js';

const MAX_GROUPS = 5;
const MAX_VALUES = 20;
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const same = (a, b) => clean(a, 60).toLowerCase() === clean(b, 60).toLowerCase();

export function parseOptionsText(text) {
  const groups = [];
  const errors = [];
  for (const line of String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^([^:]{1,40}):(.+)$/);
    if (!m) { errors.push(`"${line.slice(0, 40)}": write it as "Name: value, value".`); continue; }
    const values = [];
    for (const raw of m[2].split(/,(?![^(]*\))/).map((v) => v.trim()).filter(Boolean)) { // commas inside (…) are part of a price
      const p = raw.match(/^(.*?)\s*\(\s*([+-])\s*([\d,.]+)\s*\)$/);
      const label = clean(p ? p[1] : raw, 60);
      let delta = 0;
      if (p) {
        const minor = parseMajorToMinor(p[3]);
        if (minor === null) { errors.push(`"${raw}": the price difference must be a number, e.g. (+5000).`); continue; }
        delta = p[2] === '-' ? -minor : minor;
      }
      if (!label) continue;
      if (values.some((v) => same(v.label, label))) { errors.push(`"${label}" is listed twice under ${m[1].trim()}.`); continue; }
      values.push({ label, delta_minor: delta });
    }
    const name = clean(m[1], 40);
    if (!values.length) errors.push(`${name}: add at least one value.`);
    else if (groups.some((g) => same(g.name, name))) errors.push(`"${name}" is listed twice.`);
    else groups.push({ name, values: values.slice(0, MAX_VALUES) });
  }
  if (groups.length > MAX_GROUPS) errors.push(`At most ${MAX_GROUPS} option groups.`);
  return { options: groups.slice(0, MAX_GROUPS), errors };
}

export function formatOptionsText(options) {
  return (options ?? []).map((g) => `${g.name}: ${g.values.map((v) => v.label + (v.delta_minor ? ` (${v.delta_minor > 0 ? '+' : '-'}${Math.abs(v.delta_minor) / 100})` : '')).join(', ')}`).join('\n');
}

// The customer's choices for one product, checked against the product's own options.
// A group with a single value is chosen automatically; any other group must be chosen.
export function resolveOptions(productOptions, selected = {}) {
  const chosen = [];
  const missing = [];
  const keys = Object.keys(selected ?? {});
  for (const k of keys) if (!(productOptions ?? []).some((g) => same(g.name, k))) return { error: `"${clean(k, 40)}" is not an option of this product.` };
  for (const g of productOptions ?? []) {
    const key = keys.find((k) => same(k, g.name));
    const value = key !== undefined ? selected[key] : (g.values.length === 1 ? g.values[0].label : null);
    if (value === null || value === undefined || value === '') { missing.push(g.name); continue; }
    const v = g.values.find((x) => same(x.label, value));
    if (!v) return { error: `"${clean(value, 60)}" is not available for ${g.name}.` };
    chosen.push({ name: g.name, value: v.label, delta_minor: v.delta_minor });
  }
  if (missing.length) return { error: `Please choose: ${missing.join(', ')}.` };
  return { chosen };
}

export const optionsLabel = (chosen) => (chosen?.length ? chosen.map((c) => `${c.name}: ${c.value}`).join(', ') : '');
