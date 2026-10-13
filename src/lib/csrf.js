import { randomBytes, timingSafeEqual } from 'node:crypto';

// Synchronizer-token CSRF protection for the signed-in dashboard.
export function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const sent = Buffer.from(String(req.body?._csrf ?? ''));
  const expected = Buffer.from(req.session.csrfToken);
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
    return res.status(403).render('error', { message: 'Your session expired. Go back, refresh the page and try again.' });
  }
  next();
}
