# Connecting Skyfly's own domain (getskyfly.com)

Order matters: nothing in Render or Skyfly changes until the registry shows the domain as registered.

## 1. Buy the domain (owner, at the registrar)
- Skyfly never buys domains and never stores card details or registrar passwords.
- After buying, turn auto-renew on at the registrar and check the payment method saved there.
- Proof of purchase: Platform admin → Domains → add `getskyfly.com` → "Check registry now". It must show
  **Verified: Registered with <registrar>** and the registry's expiry date. The same check runs in the
  read-only status workflow (`Database status (read-only)` → section `== Domain`).

## 2. Add the domain in Render (owner or Claude, after approval)
Render → skyfly → Settings → Custom Domains → Add `getskyfly.com`. Render also adds `www.getskyfly.com`
(redirecting to the main one) and lists the DNS records to create. **Use the values Render shows.**
At the time of writing Render documents:

| DNS provider | Name | Type | Value |
|---|---|---|---|
| Most providers | `@` | A | `216.24.57.1` |
| Most providers | `www` | CNAME | `skyfly-gybf.onrender.com` |
| Cloudflare DNS (proxy **off**, "DNS only") | `@` | CNAME | `skyfly-gybf.onrender.com` |
| Cloudflare DNS (proxy **off**, "DNS only") | `www` | CNAME | `skyfly-gybf.onrender.com` |

Remove any AAAA records for `@` and `www` (Render has no IPv6). If the domain has CAA records, they must allow
Render's certificate authorities. Render issues the HTTPS certificate itself once DNS is verified.

## 3. Check before switching
Platform admin → Domains → "Check connection": DNS ✓ and HTTPS ✓ (`https://getskyfly.com/healthz` answers
from Skyfly). Render → Custom Domains must show the domain as **Verified** with a certificate.

## 4. Switch Skyfly's main address (Render → skyfly → Environment)
`PUBLIC_BASE_URL=https://getskyfly.com`, then save (Render redeploys). Effects:
- New links (emails, invites, order confirmations, the SDK address injected into published pages) use getskyfly.com.
- `https://skyfly-gybf.onrender.com` keeps serving the dashboard, the order API and `/p/` pages, so existing links,
  the Larose GitHub Pages page and any page with the old address keep working.
- Everyone signs in again once on the new address (sign-ins are per address).

Rollback: delete `PUBLIC_BASE_URL` (or set it back to `https://skyfly-gybf.onrender.com`) and save.

## 5. Live checks on the new address
Run the live workflows with `url=https://getskyfly.com`: `Verify deployment`, `Live pixel check (Larose)`,
`Live import, hosting and tenancy` (suite `all`). Then the same with the Render address to prove it still works.

## Renewal monitoring
Platform admin → Domains: the registry is checked every 12 hours. Reminders 30, 14 and 7 days before
expiry (emailed to platform admins once Skyfly's email sender is set up; otherwise shown in admin).
"Verified" = read from the registry. Auto-renew can only be seen in the registrar's account, so it is always
shown as "Entered by you"; a renewal becomes verified when the registry's expiry date moves later.
