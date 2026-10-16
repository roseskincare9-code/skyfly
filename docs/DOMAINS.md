# Custom domain and business subdomains

**Status: prepared, not connected.** No domain has been bought or configured. Until the
steps below are done, every business's subdomain shows "Reserved, not live", and the
dashboard stays at its Render address (https://skyfly-gybf.onrender.com).

## The planned layout (example with `skyfly.ng`)

| Address | What it serves |
|---|---|
| `app.skyfly.ng` | the dashboard (owner and clients log in here) |
| `glow.skyfly.ng/<page>/` | the published Skyfly-hosted landing pages of the business whose subdomain is `glow`, and only that business |
| a client's own domain, e.g. `shop.glowbrand.com` | one landing page (already supported per page: Landing page → Domain) |

Pages and the dashboard are on different hosts on purpose: page scripts can never read
dashboard cookies (the session cookie is host-only).

## Steps when the domain is bought (owner)

1. Buy the domain at any registrar.
2. In the registrar's DNS settings:
   - `app` → CNAME → `skyfly-gybf.onrender.com`
   - `*` (wildcard) → CNAME → `skyfly-gybf.onrender.com`
3. In Render → skyfly → Settings → Custom Domains, add `app.<domain>` and `*.<domain>`.
   Render issues the HTTPS certificates. Wildcard domains need DNS verification in Render;
   check that your Render plan allows them before relying on them.
4. In Render → skyfly → Environment, set:
   - `PLATFORM_DOMAIN=<domain>`
   - `PUBLIC_BASE_URL=https://app.<domain>`
   - `PAGES_BASE_URL` stays on a different host (for example `https://pages.<domain>`),
     because Skyfly refuses to start if pages and dashboard share a host.
   - No order-origin setting is needed: a hosted page's subdomain is allowed to send its
     own orders automatically.
5. In Platform admin → each business → Business subdomain, choose the name and click
   "Check DNS". The status changes only when DNS really points at Skyfly.

Existing links (the Render address, the Larose GitHub Pages site) keep working; nothing
moves until you change it.
