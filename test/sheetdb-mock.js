// Stand-in for SheetDB, close to the real API: one store per API id and tab; GET /keys
// (400 "Spreadsheet is empty…" with no column row), GET /search?source=*text*, POST rows,
// POST /sheet {name, first_row} to add a tab, and ?sheet=<tab> on every call.
import { createServer } from 'node:http';
import { SHEET_COLUMNS } from '../src/services/sheets.js';

export async function startSheetDbMock() {
  const tabs = new Map();
  const state = { down: false, acceptButFail: false, allowCreateTab: true, requests: [] };
  const empty = () => ({ columns: null, rows: [] });
  const tab = (id, name = '') => {
    const k = `${id}|${name}`;
    if (!name && !tabs.has(k)) tabs.set(k, { columns: [...SHEET_COLUMNS], rows: [] });
    return tabs.get(k);
  };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push(`${req.method} ${req.url}`);
      if (state.down) return send(res, 503, { error: 'unavailable' });
      if (state.quota) return send(res, 429, { error: 'Request limit exceeded. Upgrade your plan.' });
      const u = new URL(req.url, 'http://x');
      const [, id, action = ''] = u.pathname.match(/^\/api\/v1\/([A-Za-z0-9]+)(?:\/(keys|search|sheet))?$/) || [];
      if (!id) return send(res, 404, { error: 'not found' });
      if (action === 'sheet' && req.method === 'POST') {
        if (!state.allowCreateTab) return send(res, 402, { error: "You don't have an access for that method, upgrade your plan to use sheets (tabs) endpoints." });
        const { name, first_row: firstRow } = JSON.parse(body);
        if (tabs.has(`${id}|${name}`)) return send(res, 400, { error: 'Sheet already exists' });
        tabs.set(`${id}|${name}`, { columns: firstRow, rows: [] });
        return send(res, 201, { created: 1 });
      }
      const t = tab(id, u.searchParams.get('sheet') || '');
      if (!t) return send(res, 400, { error: 'Sheet not found' });
      if (action === 'keys') return t.columns ? send(res, 200, t.columns) : send(res, 400, { error: 'Spreadsheet is empty. Fill first row with the column names, each next row will be treated as a record.' });
      if (action === 'search') {
        const needle = (u.searchParams.get('source') || '').replace(/^\*|\*$/g, '').toLowerCase();
        return send(res, 200, t.rows.filter((r) => String(r.source).toLowerCase().includes(needle)));
      }
      if (req.method === 'POST') {
        if (!t.columns) return send(res, 400, { error: 'Spreadsheet is empty. Fill first row with the column names, each next row will be treated as a record.' });
        t.rows.push(JSON.parse(body).data);
        if (state.acceptButFail) return send(res, 500, { error: 'timeout' });
        return send(res, 201, { created: 1 });
      }
      return send(res, 404, {});
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  return {
    state, tabs, base, server,
    url: (id) => `${base}/${id}`,
    rows: (id, name = '') => tab(id, name)?.rows ?? [],
    makeEmpty: (id) => tabs.set(`${id}|`, empty()),
    close: () => server.close(),
  };
}
