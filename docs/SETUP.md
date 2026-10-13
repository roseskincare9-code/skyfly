# Owner setup steps

Everything Skyfly needs that only the owner can do. You never need to paste
passwords or keys into chat. Enter them directly in GitHub, Render or Supabase.

## 1. Let Claude push to the `skyfly` repository

The Claude GitHub App must have access to `roseskincare9-code/skyfly`:
https://github.com/apps/claude/installations/select_target → choose the account →
add `skyfly` to the selected repositories. Optionally, make the repository private
under GitHub → skyfly → Settings → General → Danger Zone → Change visibility.

## 2. Choose the database

Skyfly needs one PostgreSQL database of its own. Either option works without code changes:

| | Render Postgres (recommended) | Supabase Postgres |
|---|---|---|
| Cost | Paid plan for a persistent database (free databases expire) | Free tier available |
| Caveats | Same provider as the app, simplest setup | Free projects pause after a period of inactivity, and orders fail while paused |
| Settings | `DATABASE_URL` from Render, `DATABASE_SSL=false` | Session pooler connection string, `DATABASE_SSL=true` |

**Why not Supabase Auth?** Skyfly has one owner login on a server-rendered
dashboard. Password login with server-side sessions (hashed passwords,
httpOnly secure cookies, CSRF tokens, rate limits) is already built in and
tested. Supabase Auth would add a browser SDK, token handling and a second
system to configure, without adding protection for this use. If you choose
Supabase, use it for the database only.

## 3. Deploy on Render (needs your approval, since it costs money)

1. Render dashboard → **New → Blueprint** → connect the `skyfly` repository (not AIVORA). Render reads `render.yaml`.
2. Review the plans shown (web service `starter`, database `basic-256mb`) and the region.
   - For Supabase: delete the `databases:` section and the `fromDatabase` link first, then set `DATABASE_URL` and `DATABASE_SSL=true` by hand.
3. Set `PUBLIC_BASE_URL` to the service URL Render shows, e.g. `https://skyfly.onrender.com` (or `-xxxx.onrender.com`).
4. Deploy. Migrations run automatically before each deploy (`npm run migrate`).
5. Open `https://<skyfly-url>/healthz`. It must show `{"status":"ok"}`.

## 4. Create your owner account and the Larose business

1. Open `https://<skyfly-url>/signup` and create your account (password of at least 10 characters).
2. In Render → skyfly → **Shell**, run:
   `npm run seed:larose -- your-email@example.com`
   This creates *Larose Natural Skincare Nigeria* with the 5 packages and prices from the live page, the WhatsApp number 07039361243, and the registered landing page (form key `larosenigeria`).
3. In Render → skyfly → **Environment**, set `ALLOW_SIGNUP=false` so nobody else can sign up.
4. Log in and check **Products** (prices) and **Settings** (WhatsApp number).

## 5. Connect the landing page

Follow `integrations/larosenigeria/README.md`, then place one real test order
on the live page and confirm it appears in **Orders**.

## Environment variables

| Name | Required | Example / notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `DATABASE_URL` | yes | Skyfly's own Postgres connection string |
| `DATABASE_SSL` | no | `true` for Supabase or external URLs; defaults to `true` in production |
| `SESSION_SECRET` | yes | 32+ random characters (Render generates it) |
| `PUBLIC_BASE_URL` | yes (prod) | `https://skyfly.onrender.com` |
| `ALLOWED_ORIGINS` | yes | `https://roseskincare9-code.github.io` (origin only, no path) |
| `ALLOW_SIGNUP` | no | `true` only while creating the owner account |
| `ORDER_RATE_LIMIT` | no | submissions per IP per 10 minutes, default 20 |
| `PORT` | no | set by Render |

## Backups

Render's paid Postgres plans include automatic daily backups; check the
database's **Recovery** tab after creating it. You can also download all orders
at any time with **Orders → Export CSV**.
