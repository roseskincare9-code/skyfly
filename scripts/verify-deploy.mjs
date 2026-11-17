// Temporary branch only: live check of the support link on public pages.
for (const u of ['https://getskyfly.com/', 'https://getskyfly.com/pricing', 'https://getskyfly.com/signup']) {
  const r = await fetch(u, { redirect: 'manual' }); const t = await r.text();
  const link = t.match(/href="(https:\/\/wa\.me\/[^"]+)"/)?.[1] ?? 'none';
  console.log(`SUPPORT ${u} → HTTP ${r.status}; WhatsApp link ${link.replace(/&amp;/g, '&')}; number shown ${/0904 920 6695/.test(t)}`);
}
const wa = await fetch('https://wa.me/2349049206695', { redirect: 'manual' });
console.log(`SUPPORT wa.me/2349049206695 → HTTP ${wa.status} ${wa.headers.get('location') ?? ''}`);
