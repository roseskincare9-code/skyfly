export function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
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
