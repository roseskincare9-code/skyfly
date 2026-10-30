# Super Admin and business separation

## Who can do what
- **Super Admin** (Skyfly team): `users.is_platform_admin`. Never granted by signing up in production. Granted only by an
  existing Super Admin at Platform admin → Super Admins (their password is asked again), or by
  `DATABASE_URL=… node scripts/grant-admin.mjs <email>` for the very first one / recovery.
  The Super Admin area (`/admin…`) and support access to a client's workspace also need the **Super Admin sign-in**
  at `/admin/login` (password again, valid 8 hours on that device). A normal sign-in is treated as an ordinary account.
  Support visits to a workspace are logged (`admin.workspace_opened`).
- **Business owner / manager / staff**: only the businesses they are members of (`business_members`), with
  role-based sections. Every `/businesses/:id/…` request checks membership on the server; a record ID from another
  business answers "not found". Business owners get "not found" for every `/admin` route.
- **Invitations**: one live link per business and email (newest replaces older), 14 days, single use (claimed in a
  transaction), only by someone signed in with the invited email; nobody is added without accepting.

## Database guards (migration 038)
Triggers refuse links between different businesses (orders → pages, order lines → products, page products,
pixel pages, upsell product, checkouts, sheet recoveries, emails) and publishing another page's version. Sheet
connections and email steps already use composite foreign keys. Existing rows are not rewritten.
Row-level security is **not** used: the app connects with one database role and the guards above plus
per-request membership checks are the protection. See the report in the pull request for why.

Rollback of migration 038 only (keeps all data):
```sql
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tgname, tgrelid::regclass AS tbl FROM pg_trigger WHERE tgname LIKE 'same_business_%' OR tgname = 'own_published_version' LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', t.tgname, t.tbl);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS skyfly_same_business(), skyfly_own_published_version();
```

## Tests
`test/isolation-sweep.test.js` reads every route from the route files and, as Business B, sends each one with
Business A's record IDs and into Business A's workspace (GET and POST), and every admin route as both owners; it
fails if any answer shows A's data or anything of A's changes. Also: `test/super-admin.test.js`,
`test/invitations.test.js`, `npm run test:e2e:onboarding`, `npm run test:e2e:workspaces`.
