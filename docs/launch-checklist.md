# Skyfly launch checklist (live)

Updated 3 Nov 2026. ✅ done and verified · ⛔ blocked by an outside setting · 🟡 needs the owner's approval · ⬜ to do after an unblock.

## 1. Database continuity
- ✅ Daily encrypted backup (AES-256), restore-checked, round-trip checked; 30-day retention
- ✅ Isolated restore of the **stored** encrypted backup into a throwaway database ("Backup restore test (isolated)")
- ✅ Upgrade, downtime and rollback plan: `docs/database-continuity.md`, `docs/capacity-and-upgrade-plan.md`
- 🟡 **Upgrade `skyfly-db` to Basic-256mb before 14 Nov 13:40 UTC.** Render → `skyfly-db` → Settings → Instance type.
  About $7/month with 1 GB storage included; extra storage $0.30/GB/month; paid databases get point-in-time recovery.
  Render's upgrade screen shows the exact price before you confirm.
- ⬜ Offline copy: Actions → "Database backup" → latest green run → download `skyfly-backup-encrypted`; compare
  its SHA-256 with the run log; keep it offline. Decrypt with the passphrase described in `docs/database-continuity.md`.

## 2. Public registration (opens by itself when everything below passes)
- ✅ Signup form: name, business, email, phone, password + confirmation, Terms and Privacy checkbox, bot trap
- ✅ Each registration: new account, own private workspace, unique business ID, Owner role, never Super Admin
- ✅ Email verification before the dashboard; resend; single-use links; honest failure messages
- ✅ Password reset by email (single use, 1 hour), "password changed" email, other sessions ended
- ✅ Turnstile verified on the server; no production bypass
- ✅ **Automatic launch checks** (start-up, every 6 hours, or Platform settings → "Run launch checks now"):
  a real test send through Resend to its test inbox, and Cloudflare's check of the Turnstile secret.
  Registration and the Sign Up button appear only when both pass.
- ⛔ Resend settings on Render: `SKYFLY_NOTIFY_PROVIDER=resend`, `SKYFLY_NOTIFY_API_KEY`, `SKYFLY_NOTIFY_FROM`, `SKYFLY_NOTIFY_FROM_NAME=Skyfly`
- ⛔ Turnstile settings on Render: `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`
- ⬜ **Manual acceptance test** (a person, once, because the bot check cannot be scripted):
  1. Open https://getskyfly.com/login: the "Create Your Business Account" button is visible.
  2. Register a test business ("… (test)") with a mailbox you can read.
  3. The verification email arrives; the link opens your new, empty dashboard.
  4. Log out; log in at /login; you land on that dashboard.
  5. /forgot-password: the reset email arrives; set a new password; the old one no longer works.
  6. /admin with this account: "Page not found".

## 3. Business ownership
- ✅ Separate Super Admin sign-in; invitation for an admin-only account (Super Admins → "Create a separate Super Admin account")
- 🟡 Mapping for businesses #1–#5 (all owned by the founder account, which is also the only Super Admin). See the launch report.

## 4. Security
- ✅ Every workspace route enforces membership on the server; same-business database guards; route sweeps in tests
- ✅ Live two-business attack test passed (501 requests, 0 leaks)
- ✅ Three-business live test (A, B, C) ready: the Super Admin test account creates the businesses with owner invitations (the bot check is never bypassed)
- ⬜ Add GitHub secrets `SKYFLY_ADMIN_EMAIL` / `SKYFLY_ADMIN_PASSWORD` (a separate Super Admin **test** account), then run "Live isolation audit"
- ✅ Account protection: per-email sign-in limits, account disabling, sessions ended on password change

## 5. Historical data
- ✅ Larose: 29 real orders safe in Skyfly; reconciliation and append-only process in `docs/larose-sheet-reconciliation.md`
- 🟡 Approve the target sheet, the two possible duplicates, then the append
- 🟡 Orders 127 (AL-4M694RX) and 128 (BE-R74GERH): isolation-test orders in test businesses #8/#9; approve marking them as test

## 6. Commercial readiness
- ✅ Plans priced: Business Pro ₦199,000/month, Agency VIP ₦399,000/month; per-plan limits enforceable
- 🟡 Plan contents: `docs/plans-comparison-PROPOSAL.md` (enter the numbers in Platform settings)
- ✅ Infrastructure inventory recorded (Platform admin → Infrastructure) with renewal alerts at 30/14/7/3/0 days
- ⬜ Fill in prices you know (domain), confirm auto-renew, add Resend/Turnstile once set up
- 🟡 Legal review: `docs/legal/*-DRAFT.md`
- 🟡 Web service: Render Starter (about $7/month) so Skyfly does not sleep
