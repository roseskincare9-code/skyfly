// The Super Admin sign-in (password again) that platform administration needs after the normal sign-in.
export async function superAdminSignIn(page, base, email, password) {
  await page.goto(`${base}/admin/login`);
  await page.fill('[data-admin-login] #email', email);
  await page.fill('[data-admin-login] #password', password);
  await Promise.all([page.waitForLoadState('load'), page.click('[data-admin-login] button[type=submit]')]);
  if (new URL(page.url()).pathname !== '/admin') throw new Error(`Super Admin sign-in refused (${page.url()})`);
}
