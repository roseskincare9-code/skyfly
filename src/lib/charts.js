// Small server-side SVG chart helpers (no client JavaScript needed).
const f = (n) => Math.round(n * 10) / 10;

// Smooth area/line chart. points: [{ label, value }]. Returns paths, axis ticks and dots.
export function lineChart(points, { width = 640, height = 220, pad = { t: 16, r: 12, b: 28, l: 56 } } = {}) {
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...points.map((p) => p.value), 0);
  const top = niceMax(max);
  const x = (i) => pad.l + (points.length <= 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v) => pad.t + h - (top ? (v / top) * h : 0);
  const xy = points.map((p, i) => [x(i), y(p.value)]);
  let line = '';
  xy.forEach(([px, py], i) => {
    if (i === 0) { line += `M${f(px)},${f(py)}`; return; }
    const [qx, qy] = xy[i - 1];
    const cx = (qx + px) / 2;
    line += ` C${f(cx)},${f(qy)} ${f(cx)},${f(py)} ${f(px)},${f(py)}`;
  });
  const area = xy.length ? `${line} L${f(xy.at(-1)[0])},${f(pad.t + h)} L${f(xy[0][0])},${f(pad.t + h)} Z` : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ y: f(y(top * t)), value: top * t }));
  const every = Math.max(1, Math.ceil(points.length / 7));
  const labels = points.map((p, i) => ({ x: f(x(i)), text: p.label })).filter((_, i) => i % every === 0 || i === points.length - 1);
  const peak = points.reduce((best, p, i) => (p.value > (best?.value ?? -1) ? { ...p, x: f(x(i)), y: f(y(p.value)) } : best), null);
  return { width, height, line, area, ticks, labels, baseline: f(pad.t + h), left: pad.l, right: width - pad.r, peak: max > 0 ? peak : null };
}

function niceMax(v) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// Donut chart: segments [{ value, color }]. Returns SVG arc paths around (r, r).
export function donut(segments, { r = 70, thickness = 18 } = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const c = r;
  let angle = -Math.PI / 2;
  const arcs = [];
  for (const s of segments) {
    if (!s.value) continue;
    const share = s.value / total;
    const end = angle + share * Math.PI * 2 - (share < 1 ? 0.0001 : 0.001);
    const large = share > 0.5 ? 1 : 0;
    const p = (a, rad) => `${f(c + rad * Math.cos(a))},${f(c + rad * Math.sin(a))}`;
    const ro = r; const ri = r - thickness;
    arcs.push({ ...s, share, d: `M${p(angle, ro)} A${ro},${ro} 0 ${large} 1 ${p(end, ro)} L${p(end, ri)} A${ri},${ri} 0 ${large} 0 ${p(angle, ri)} Z` });
    angle = end + 0.0001;
  }
  return { size: r * 2, total, arcs };
}

// Short money labels for chart axes: ₦1.2M, ₦850K.
export function shortMoney(minor, currency = 'NGN') {
  const v = Number(minor) / 100;
  const sym = { NGN: '₦', GBP: '£', USD: '$', EUR: '€' }[currency] ?? '';
  if (v >= 1e6) return `${sym}${f(v / 1e6)}M`;
  if (v >= 1e3) return `${sym}${f(v / 1e3)}K`;
  return `${sym}${Math.round(v)}`;
}
