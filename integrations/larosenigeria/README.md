# Larose Nigeria landing page → Skyfly

Connects the existing order form at
https://roseskincare9-code.github.io/Larosenigeria/ (repo `roseskincare9-code/Larosenigeria`,
single file `index.html`) to Skyfly. The page stays on GitHub Pages; only the
order form's behaviour changes.

## What the current page does (inspected)

| Field | Element id | Notes |
|---|---|---|
| Full name | `fn` | required |
| Delivery address | `addr` | required |
| Phone / WhatsApp | `ph` | required |
| Email | `em` | optional |
| Package | `pr` (select) | 5 options; price is only in the option text |

`doSub()` posted the order to SheetDB, **ignored any error**, and always showed
"Order Received!", so a failed save looked like a success.

## What the patch changes

`patch.py` makes the smallest change it can, and stops with an error if the page has changed shape:

1. Adds `data-product="package-N"` and `data-price` to the five package options. Their labels and values stay the same, so `selectPkg()` and the package buttons still work.
2. Adds **State** (required), **Quantity** (1–5) and **Notes** fields using the page's existing `.fg` style. It also adds a hidden anti-spam field and an error box.
3. Replaces `doSub()` so the form:
   - checks the required fields in the browser;
   - POSTs to `SKYFLY_API/api/public/orders` with form key `larosenigeria`, the product code and quantity, the displayed price (Skyfly re-checks it against its own price list), the page URL, the referrer and UTM tags;
   - sends a stable **idempotency key**, so double taps, retries and the back button can never create a second order;
   - **redirects to the Skyfly confirmation page only after Skyfly saves the order**;
   - on failure, shows a clear message, keeps every field filled in, re-enables the button, and offers a WhatsApp link as an optional fallback;
   - fires the Meta Pixel `Lead` event only after the order is saved;
   - keeps sending a copy to the existing SheetDB sheet as a best-effort backup that never blocks the order. To stop that, delete the line that starts with `try{fetch(SHEET`.

`landing-page.diff` shows the exact changes for review, with a placeholder URL.

## Applying it (only after Skyfly is deployed)

Apply this only after Skyfly is live and `https://<skyfly-url>/healthz` returns
`{"status":"ok"}`. If you apply it first, the live form will show an error on
every order.

```sh
git clone https://github.com/roseskincare9-code/Larosenigeria
cd Larosenigeria
python3 ../skyfly/integrations/larosenigeria/patch.py index.html index.html https://<skyfly-url>
git diff            # review
git commit -am "Send orders to Skyfly" && git push
```

Then place one real test order on the live page, check that it appears in the
Skyfly dashboard, and mark it **Cancelled**.

## Keeping prices in sync

Skyfly's **Products** page is the source of truth for prices. If you change a
price in Skyfly, update the same price on the landing page too. Until you do,
Skyfly refuses orders for that package and asks the customer to refresh, so
nobody is charged a different price from the one they saw.
