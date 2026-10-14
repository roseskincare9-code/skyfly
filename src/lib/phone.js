// Normalises phone numbers to E.164 (+234...). Nigerian local formats such as
// 09049206695 are assumed when no country code is given.
export function normalizePhone(input) {
  const raw = String(input ?? '').trim();
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!hasPlus && /^0[789][01]\d{8}$/.test(digits)) return `+234${digits.slice(1)}`;
  if (!hasPlus && /^[789][01]\d{8}$/.test(digits)) return `+234${digits}`;
  if (/^234[789][01]\d{8}$/.test(digits)) return `+${digits}`;
  if (hasPlus && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

// Digits only, as wa.me expects.
export function whatsappDigits(e164) {
  return String(e164 ?? '').replace(/\D/g, '');
}

export function maskPhone(e164) {
  const s = String(e164 ?? '');
  return s.length > 6 ? `${s.slice(0, 4)}${'•'.repeat(s.length - 7)}${s.slice(-3)}` : s;
}
