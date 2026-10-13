import { randomBytes, randomInt } from 'node:crypto';

// Crockford-style alphabet: no 0/O or 1/I/L, so references read cleanly over the phone.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateReference(prefix) {
  let code = '';
  for (let i = 0; i < 7; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${code}`;
}

export function generateToken() {
  return randomBytes(24).toString('base64url');
}
