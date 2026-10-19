# Skyfly guide

The four things you'll do: import a page, connect its order form, set up
pixels, and manage orders.

## 1. Import a landing page

1. **Pages → Import a landing page.** Give it a name and choose your file:
   - a **.zip** with `index.html` and its folders (css, js, images, fonts), or
   - a single **.html** file (only if everything it needs comes from the internet).
2. Skyfly opens the page's screen and shows **Check before publishing**:
   - **Missing files**: images or styles the page refers to that weren't in the ZIP.
   - **External services**: e.g. "SheetDB", "Paystack", "WhatsApp links", with what each means.
   - **Tracking code already in the page**: Skyfly won't add a second copy.
   - **Order form**: whether it is connected to Skyfly yet.
3. Click **Preview** to see it exactly as visitors will (the link works for one hour).
4. Under **Page settings**, tick the **connected products** the page sells, then **Save**.
5. Click **Publish this version**. The live address appears: until you have a domain it is on
   the Skyfly address, e.g. `https://skyfly-gybf.onrender.com/p/glow-promo/` (it stays the same
   when you publish new versions).
   **Unpublish** takes it offline immediately. Uploading again creates a new version. The live page doesn't change until you publish it.

Skyfly never edits your page's design. When serving it, it adds its small script and your pixels,
and speeds it up: WebP copies of large images in several sizes (the original stays as the fallback),
lazy loading for images further down, reserved space for images (no jumping), long-lived browser
caching for the page's files, and compression. Ad pixels load after the page has appeared.

**Pages on the Skyfly address run in a secure sandbox:** page scripts cannot reach your dashboard,
but they also cannot use browser storage or cookies, and browsers don't reuse their cache between
visits there. A custom domain or business subdomain removes both limits.

**Test mode** (Page settings): every order from the page is saved as a test order, never counted in
sales, sent to Meta/TikTok, or emailed. The demo page `/p/skyfly-demo/` is always in test mode.

**Custom domain (optional):** on the page's screen, enter e.g. `shop.yourbrand.com`,
follow the 3 steps shown (DNS record, add the domain in Render, publish), then
**Check DNS**.

## 2. Connect the order form

**A page does not send orders to Skyfly by itself.** Until the form is connected,
orders go wherever they went before (e.g. a Google Sheet) and do not appear in Skyfly.

### Easiest: Skyfly checkout (no coding)

On the page's screen, click **Add Skyfly checkout** (or put `<div data-skyfly-checkout></div>`
where the order form should go). Customers choose a package and quantity, enter their details,
review the order and place it. The confirmation, with the order reference and the total Skyfly
calculated, appears only after Skyfly has saved the order; if saving fails they see why and can try
again. Packages and prices come from the page's **connected products**. Optional attributes:
`data-title`, `data-button`, `data-place` (button texts) and `data-product="code"` (preselected).

### Option A: standard HTML form

Add `data-skyfly-form` to the `<form>` tag and use these field names:

| Field | `name=` | Required |
|---|---|---|
| Customer name | `name` | yes |
| Phone | `phone` | yes |
| Delivery address | `address` | yes |
| Email | `email` | no |
| State | `state` | no |
| Notes | `notes` | no |
| Product | `product` (a `<select>`; each `<option>` has `data-product="CODE"` and `data-price="PRICE"`) | yes |
| Quantity | `quantity` | no (default 1) |

```html
<form data-skyfly-form>
  <input name="name" required> <input name="phone" required> <input name="address" required>
  <select name="product">
    <option data-product="package-2" data-price="33000">Combo ₦33,000</option>
  </select>
  <input name="quantity" value="1">
  <button type="submit">Order now</button>
</form>
```

`CODE` is the product code on Skyfly's **Products** screen. `data-price` is the price
the page shows. If it doesn't match Skyfly's price, the order is refused and the
customer is asked to refresh, so nobody is charged a different price from what
they saw.

- **Pages hosted on Skyfly:** nothing else to add. The script is included automatically.
- **Pages hosted elsewhere** (e.g. GitHub Pages): add the line shown under **Connect your order form**
  on the page's screen, just before `</body>`:
  `<script src="https://YOUR-SKYFLY/sdk/skyfly.js" data-page="FORM-KEY" defer></script>`
  and enter the page's address in **External URL**, so Skyfly accepts orders from it.

**Connection status.** A page's screen shows one of three states:
- **Not connected**: orders from this page don't reach Skyfly.
- **Connection code found, not verified**: the code is there, but no order has arrived yet.
- **Orders connected ✓ verified**: a real submission from the page was saved (the first order's reference is shown).

Only the last one means it works. Verify it by placing one order on the live page, then
open that order and click **Mark as test order**. Publishing a new version sets the
page back to "not verified" until another order arrives.

On submit, Skyfly saves the order first. **Only then** does the customer see the
confirmation page with their order reference and WhatsApp button. If saving fails,
they see a message, everything they typed stays, and they can try again. Double
taps and retries never create duplicate orders.

### Option B: custom forms (no `<form>` tag, e.g. the current Larose page)

Call the script from your own button code:

```js
Skyfly.submitOrder({
  customer: { name, phone, address, email, state, notes },
  items: [{ product: 'package-3', quantity: 1, unitPrice: 51500 }],
}).then((r) => { if (r.ok) location.href = r.confirmationUrl; else showError(r.message); });
```

For the existing Larose page there is a ready-made patch: `integrations/larosenigeria/`.

### Option C: from another service's server (form provider, Zapier, Make)

**Settings → API keys → Create key**, then have the service `POST` to
`https://YOUR-SKYFLY/api/public/orders` with `Authorization: Bearer sky_…`.
The request body is the same as in the README. Never put an API key in a web page.

### Upsell (optional add-on at checkout)

Landing pages → the page → **Upsell at checkout**: choose one of your products (not one of the
page's packages), a headline and what is included. Customers see it under their details with an
**Add** button; the total updates at once. Skyfly prices the add-on from your product list when the
order is saved (browser totals are never used), and marks it "Add-on" in the order, the
confirmation and the Google Sheet. Pages using Skyfly's checkout show it automatically; the Larose
page shows it too. "No upsell" removes it.

## 3. Pixels

**Pixels** screen → for Meta and/or TikTok:

1. Tick **Turn on**, paste the **Pixel ID**, choose browser events:
   - **PageView**: every visit.
   - **ViewContent**: optional; also fires on page load.
   - **InitiateCheckout**: once, when the visitor starts filling in the order form.
   - **Lead**: once per order, only after Skyfly has saved the order.
2. **Purchase is never sent from the browser.** To report real sales, tick
   **Send Purchase when an order is marked Paid** and paste a server access token:
   - Meta: Events Manager → your dataset/pixel → Settings → *Conversions API* → Generate access token.
   - TikTok: Events Manager → your pixel → Settings → *Events API* → Generate access token.

   Paste it **in Skyfly only**, never in chat or email. It's stored encrypted and never shown again.
3. **Testing:** copy the *test event code* from the platform's **Test events** screen into
   Skyfly, save, then **Send test Purchase**. It should appear in the platform's Test events.
   Check browser events with the Meta Pixel Helper / TikTok Pixel Helper browser extension.
4. **Per page:** choose a page at the top of the Pixels screen to give it its own pixel.
   Otherwise it uses the business default.

If your page already contains its own pixel code, Skyfly detects it and doesn't load
the same pixel twice. For one clean setup, remove the old code from the page and
let Skyfly manage it.

### Configured is not the same as verified

The Pixels screen shows three separate lines for each pixel:

| Line | Meaning | How it becomes "Verified" |
|---|---|---|
| **Configured** | ID saved and switched on | — |
| **Browser events** | PageView / InitiateCheckout / Lead reach the platform | Skyfly can't see inside Meta or TikTok. Check with the steps below, then click **I've checked: events arrive once** (recorded with your name and the date) |
| **Server Purchase** | Skyfly can send Purchase to the platform | Automatically, when the platform accepts a test or real Purchase from Skyfly |

Changing the pixel ID resets both verifications; changing the token resets the server one.

**Browser check (5 minutes):**
1. In Meta Events Manager or TikTok Events Manager, open your pixel's **Test events**
   (or install the Meta Pixel Helper / TikTok Pixel Helper extension).
2. Open the published page: **PageView** appears **once**.
3. Tap into the order form: **InitiateCheckout** appears once.
4. Submit a test order: **Lead** (TikTok shows it as **SubmitForm**) appears once, and **no Purchase**.
5. In Skyfly, mark that order as a **test order**, then click **I've checked** on the Pixels screen.

**Server check:** paste the test event code from the platform's Test events screen,
save, click **Send test Purchase**, and confirm it appears there.

## 4. Orders

- **Orders**: search by reference, name, phone or email, and filter by status, payment,
  source, page or date. **Export CSV** downloads what's on screen.
- Open an order to **Call** or **WhatsApp** the customer, and update:
  - **Order status**: Pending → Confirmed/Approved → Processing → Dispatched → Delivered (or Cancelled / Returned).
  - **Payment status**: Unpaid, Payment pending, Paid, Payment failed, Refunded.
    Mark **Paid** only when the money is received. That's what sends Purchase to your pixels (once).
- **+ Add order**: for orders taken by phone or WhatsApp.
- **Mark as test order**: for orders you placed yourself. They stay in the list with a TEST label
  but are left out of all sales figures and never sent to ad platforms as purchases.
- **Overview**: paid revenue, money still to collect, order counts by status, recent orders and orders per page.
- **Settings → Activity log**: who changed what.

## 5. Google Sheets: the free direct connection

**Google Sheets → Connect a spreadsheet directly.** Skyfly shows a short script with a private key.
In your Google Sheet: **Extensions → Apps Script**, replace everything with the script, **Save**,
then **Deploy → New deployment → Web app** (Execute as: *Me*; Who has access: *Anyone*), allow
access, and paste the **Web app URL** into Skyfly. Skyfly checks it at once. Orders are saved in
Skyfly first and then copied (one row per order, never twice, column row created automatically).
No SheetDB account or SheetDB request limit is involved. All the business's pages use its default
spreadsheet unless a page is given its own.

## 6. Email automations: triggers

- **Order still processing**: while an order stays in Processing; stops when it changes.
- **Post-purchase follow-up**: N days after delivery or after the order date (e.g. 7, 10, 30).
- **Order not yet paid**: while the order is not marked Paid; stops once Paid, Refunded, Cancelled
  or Returned. About payment only: an order in Processing is never treated as "not bought".
- **Customer has not ordered again**: N days after the customer's latest order, only if they have
  not ordered since. Marketing: only contacts who agreed to offers.

Each email is checked again right before sending (status, unsubscribe, consent, subscription) and
is never sent twice. Only orders reaching a trigger after the automation is activated get emails.
Abandoned-checkout emails are not offered: Skyfly only has a customer's details once they order.
These are emails sent through your own email provider; SMS and WhatsApp are not sent automatically.
