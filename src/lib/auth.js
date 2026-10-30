export function requireAuth(req, res, next) {
  if (!req.session.userId) {
    // The Super Admin area has its own sign-in page; everything else uses the business login.
    if (/^\/admin(\/|$|\?)/.test(req.originalUrl)) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.redirect('/login');
  }
  next();
}

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
