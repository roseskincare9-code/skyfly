// Fills Skyfly's current registration form (name, email, password + confirmation, terms; business name and
// phone only when the form asks for them) and waits until the browser has left /signup.
export async function signUpInBrowser(page, base, { name, email, password, business = 'E2E Test Business (test)', phone = '+234 800 000 0000' }) {
  await page.goto(`${base}/signup`);
  await page.fill('#name', name);
  await page.fill('#email', email);
  await page.fill('#password', password);
  if (await page.locator('#confirm').count()) await page.fill('#confirm', password);
  if (await page.locator('#business_name').isVisible().catch(() => false)) await page.fill('#business_name', business);
  if (await page.locator('#phone').isVisible().catch(() => false)) await page.fill('#phone', phone);
  if (await page.locator('#accept_terms').count()) await page.check('#accept_terms');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/signup'), { timeout: 30000 }), page.click('form button[type=submit]')]);
}
