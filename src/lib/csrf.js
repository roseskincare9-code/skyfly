import { randomBytes, timingSafeEqual } from 'node:crypto';

const UPLOAD_ROUTES = /^\/businesses\/\d+\/landing-pages\/(?:\d+\/)?upload$/;

function valid(req) {
  const sent = Buffer.from(String(req.body?._csrf ?? ''));
  const expected = Buffer.from(req.session.csrfToken);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

function reject(res) {
  return res.status(403).render('error', { message: 'Your session expired. Go back, refresh the page and try again.' });
}

// Synchronizer-token CSRF protection for the signed-in dashboard.
export function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // File uploads are parsed later by the route, which calls requireCsrf after parsing.
  // Only these upload routes may defer the check; any other multipart POST is refused.
  if (req.is('multipart/form-data') && UPLOAD_ROUTES.test(req.path)) return next();
  return valid(req) ? next() : reject(res);
}

export function requireCsrf(req, res, next) {
  return valid(req) ? next() : reject(res);
}
