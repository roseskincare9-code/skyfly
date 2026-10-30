// Super Admin sessions. Being a platform admin (users.is_platform_admin, set only by another Super
// Admin or the grant-admin script) is not enough on its own: the Super Admin area and support access
// to a client's workspace also need a Super Admin sign-in on this session (password entered again at
// /admin/login), which lasts ADMIN_SESSION_HOURS. Nothing the browser sends can grant it.
export const ADMIN_SESSION_HOURS = 8;

export function adminVerified(req) {
  const s = req.session;
  return Boolean(s?.userId && s.adminUserId === s.userId && s.adminVerifiedAt && Date.now() - s.adminVerifiedAt < ADMIN_SESSION_HOURS * 3600e3);
}

// Only same-site paths in the admin area or a workspace are followed after signing in.
export const safeAdminNext = (next) => (/^\/(admin(\/[\w./?=&-]*)?|businesses\/\d+[\w./?=&-]*)$/.test(String(next ?? '')) ? String(next) : '/admin');
