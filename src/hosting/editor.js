// Content editor for hosted landing pages. Reads a page's HTML and lists what can be
// edited (title and description, visible text, images, colour settings, package
// prices, sections), then applies changes at exact source positions: everything not
// edited stays byte-for-byte the same, scripts included. Each save becomes a new version.
import { parse } from 'parse5';

const TEXT_PARENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'li', 'span', 'strong', 'em', 'b', 'i', 'small', 'label', 'option', 'td', 'th', 'div', 'blockquote', 'figcaption', 'summary', 'dt', 'dd']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'textarea', 'title', 'head']);
const HEX = /^#[0-9a-fA-F]{3,8}$/;

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  const kids = node.content?.childNodes ?? node.childNodes ?? [];
  for (const child of kids) walk(child, visit, [...ancestors, node]);
}

export function analyzePage(html) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const out = { title: null, description: null, texts: [], images: [], colors: [], prices: [], sections: [] };
  const sectionsByParent = new Map();

  walk(doc, (node, ancestors) => {
    const loc = node.sourceCodeLocation;
    const parent = ancestors.at(-1);
    if (node.nodeName === '#text' && loc) {
      const raw = html.slice(loc.startOffset, loc.endOffset);
      const value = node.value.replace(/\s+/g, ' ').trim();
      if (parent?.nodeName === 'title') {
        out.title = { value, start: loc.startOffset, end: loc.endOffset };
      } else if (parent?.nodeName === 'style') {
        // Colour settings: CSS custom properties with a hex value (e.g. --gold:#C9A96E).
        for (const m of raw.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
          const start = loc.startOffset + m.index + m[0].lastIndexOf(m[2]);
          out.colors.push({ id: out.colors.length, name: m[1], value: m[2], start, end: start + m[2].length });
        }
      } else if (value && parent && TEXT_PARENTS.has(parent.nodeName) && !ancestors.some((a) => SKIP.has(a.nodeName))) {
        out.texts.push({ id: out.texts.length, tag: parent.nodeName, value, start: loc.startOffset, end: loc.endOffset });
      }
    }
    if (!node.tagName || !loc) return;
    if (node.tagName === 'meta' && attr(node, 'name') === 'description' && loc.attrs?.content) {
      out.description = { value: attr(node, 'content'), start: loc.attrs.content.startOffset, end: loc.attrs.content.endOffset };
    }
    if (node.tagName === 'img' && loc.attrs?.src) {
      const src = attr(node, 'src');
      if (src && !/^(data:|https?:|\/\/)/i.test(src)) out.images.push({ id: out.images.length, src, alt: attr(node, 'alt') || '' });
    }
    if (node.tagName === 'option' && attr(node, 'data-price') !== undefined && loc.attrs?.['data-price']) {
      const a = loc.attrs['data-price'];
      out.prices.push({ id: out.prices.length, product: attr(node, 'data-product') || null, value: attr(node, 'data-price'), label: attr(node, 'value') || '', start: a.startOffset, end: a.endOffset });
    }
    if (node.tagName === 'section' && parent?.sourceCodeLocation) {
      const key = parent.sourceCodeLocation.startOffset;
      if (!sectionsByParent.has(key)) sectionsByParent.set(key, []);
      let label = attr(node, 'id') || '';
      walk(node, (n) => { if (!label && /^h[1-3]$/.test(n.nodeName)) label = (n.childNodes || []).filter((c) => c.nodeName === '#text').map((c) => c.value).join(' ').trim(); });
      sectionsByParent.get(key).push({ label: label || `Section (${attr(node, 'class') || 'no name'})`, start: loc.startOffset, end: loc.endOffset });
    }
  });
  // Only one group of sibling sections is offered for reordering: the largest (the page body).
  const group = [...sectionsByParent.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  out.sections = group.length >= 2 ? group.map((s, i) => ({ id: i, ...s })) : [];
  return out;
}

export class EditError extends Error {}

function applyEdits(html, edits) {
  edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < edits.length; i += 1) {
    if (edits[i].end > edits[i - 1].start) throw new EditError('Two changes overlap. Save one change at a time.');
  }
  let out = html;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// changes: { title, description, texts: {id: value}, colors: {id: value}, prices: {id: value},
//            sections: { order: [ids…], remove: [ids…] } }
export function applyChanges(html, changes) {
  const a = analyzePage(html);
  const edits = [];
  const changed = [];
  if (changes.title !== undefined && a.title && changes.title.trim() !== a.title.value) {
    const raw = html.slice(a.title.start, a.title.end);
    edits.push({ start: a.title.start, end: a.title.end, text: raw.match(/^\s*/)[0] + escapeText(changes.title.trim()) + raw.match(/\s*$/)[0] });
    changed.push('title');
  }
  if (changes.description !== undefined && a.description && changes.description.trim() !== a.description.value) {
    const raw = html.slice(a.description.start, a.description.end);
    const q = raw.match(/=\s*(["']?)/)?.[1] || '"';
    edits.push({ start: a.description.start, end: a.description.end, text: `content=${q || '"'}${escapeAttr(changes.description.trim())}${q || '"'}` });
    changed.push('description');
  }
  for (const [id, value] of Object.entries(changes.texts ?? {})) {
    const t = a.texts[Number(id)];
    if (!t || typeof value !== 'string') continue;
    const next = value.replace(/\s+/g, ' ').trim();
    if (next === t.value) continue;
    if (!next) throw new EditError(`Text ${Number(id) + 1} can't be empty. Remove the section instead.`);
    const raw = html.slice(t.start, t.end);
    edits.push({ start: t.start, end: t.end, text: raw.match(/^\s*/)[0] + escapeText(next) + raw.match(/\s*$/)[0] });
    changed.push(`text ${t.tag}`);
  }
  for (const [id, value] of Object.entries(changes.colors ?? {})) {
    const c = a.colors[Number(id)];
    if (!c || !value || value.toLowerCase() === c.value.toLowerCase()) continue;
    if (!HEX.test(value)) throw new EditError(`${c.name}: enter a colour like #C9A96E.`);
    edits.push({ start: c.start, end: c.end, text: value });
    changed.push(`colour ${c.name}`);
  }
  for (const [id, value] of Object.entries(changes.prices ?? {})) {
    const p = a.prices[Number(id)];
    if (!p || value === undefined || String(value).trim() === p.value) continue;
    const v = String(value).replace(/[,\s₦£$€]/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) throw new EditError(`${p.label || 'Package'}: enter the price as a number, e.g. 23500.`);
    const raw = html.slice(p.start, p.end);
    const q = raw.match(/=\s*(["']?)/)?.[1] || '"';
    edits.push({ start: p.start, end: p.end, text: `data-price=${q || '"'}${v}${q || '"'}` });
    changed.push(`price ${p.product || p.label}`);
  }
  let out = applyEdits(html, edits);

  // Sections: remove and/or reorder (second pass, on the edited page).
  const s = changes.sections;
  if (s && (s.remove?.length || s.order?.length)) {
    const b = analyzePage(out);
    const remove = new Set((s.remove ?? []).map(Number));
    const order = (s.order?.length === b.sections.length ? s.order.map(Number) : b.sections.map((x) => x.id)).filter((id) => b.sections[id]);
    if (new Set(order).size !== b.sections.length) throw new EditError('Section order is incomplete. Reload and try again.');
    const kept = order.filter((id) => !remove.has(id));
    if (kept.length === 0) throw new EditError('A page needs at least one section.');
    const same = kept.length === b.sections.length && kept.every((id, i) => id === i);
    if (!same) {
      const slices = b.sections.map((x) => out.slice(x.start, x.end));
      const slots = b.sections.map((x, i) => ({ start: x.start, end: x.end, text: i < kept.length ? slices[kept[i]] : '' }));
      out = applyEdits(out, slots);
      if (remove.size) changed.push(`removed ${remove.size} section(s)`);
      if (kept.some((id, i) => id !== [...Array(b.sections.length).keys()].filter((x) => !remove.has(x))[i])) changed.push('reordered sections');
    }
  }
  return { html: out, changed };
}
