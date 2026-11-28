// Express 4 does not catch rejected promises; route handlers go through this.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Sends a stored file (a Buffer) with HTTP byte-range support. Safari on iPhone/iPad and macOS only plays
// <video>/<audio> when the server answers "Range: bytes=…" with 206 Partial Content, and every browser
// needs it to seek. One range per request (what media players send); anything else gets the whole file.
export function sendWithRanges(req, res, body) {
  const size = body.length;
  res.set('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m || (!m[1] && !m[2]) || req.method !== 'GET') return res.send(body);
  let start; let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } // last N bytes
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) {
    res.set('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
  return res.send(body.subarray(start, end + 1));
}
