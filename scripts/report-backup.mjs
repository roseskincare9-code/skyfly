// Reports a backup or restore-test result to Skyfly (Platform admin → System status), with the server's
// backup key. Sends only the result, run link, size, checksum and counts: never data. A failure is shown
// on the Super Admin dashboard and emailed to Super Admins when an email sender is set up.
//   SKYFLY_URL=… SKYFLY_BACKUP_KEY=… KIND=backup|restore_test STATUS=success|failure node scripts/report-backup.mjs
import { readFile } from 'node:fs/promises';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const key = process.env.SKYFLY_BACKUP_KEY || '';
if (!SKYFLY || !key) { console.log('Not reported: no SKYFLY_URL or backup key.'); process.exit(0); }

// Optional facts written by the job (sizes and counts only).
let facts = {};
try { facts = JSON.parse(await readFile(process.env.FACTS_FILE || 'backup-facts.json', 'utf8')); } catch { /* none */ }
const status = process.env.STATUS === 'success' ? 'success' : 'failed';
const body = {
  kind: process.env.KIND === 'restore_test' ? 'restore_test' : 'backup',
  status,
  run_id: process.env.GITHUB_RUN_ID,
  run_url: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
  size_bytes: facts.size_bytes, sha256: facts.sha256, tables: facts.tables, total_rows: facts.total_rows,
  detail: status === 'failed' ? (process.env.DETAIL || 'The job failed: open the run for the step that failed.') : process.env.DETAIL || undefined,
};
let res;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  res = await fetch(`${SKYFLY}/admin/backup-report`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) }).catch((err) => ({ ok: false, status: String(err.message) }));
  if (res.ok) break;
  await new Promise((r) => setTimeout(r, 15000));
}
if (!res.ok) { console.log(`Report not accepted (${res.status}). The dashboard will show the backup as missing after 36 hours.`); process.exit(0); }
const out = await res.json();
console.log(`Reported to Skyfly: ${body.kind} ${status} (record ${out.id}${out.notified ? `; ${out.notified}` : ''}).`);
