const SYMBOLS = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };

// Amounts are integer minor units (kobo, cents). Displayed without decimals
// when whole, which is how Naira prices are normally shown.
export function formatMoney(minor, currency = 'NGN') {
  const major = Number(minor) / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  const amount = major.toLocaleString('en-NG', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  return `${SYMBOLS[currency] || `${currency} `}${amount}`;
}

// Parses an admin-entered major amount like "23,500" or "23500.50" into minor units.
export function parseMajorToMinor(input) {
  const cleaned = String(input ?? '').replace(/[,\s₦]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
