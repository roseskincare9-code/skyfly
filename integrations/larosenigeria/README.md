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

## Transition: Skyfly and the Google Sheet side by side

The patch does not switch SheetDB off. While `SKYFLY_SHEET_FALLBACK=true` (the default):

| What happens | Skyfly | Google Sheet ("source" column) | Customer sees |
|---|---|---|---|
| Skyfly saves the order | order saved | copy, `… \| Skyfly LR-XXXXXXX` | Skyfly confirmation page |
| Customer typed something invalid | nothing | nothing | error message, details kept, can retry |
| Skyfly unreachable or erroring | nothing | row, `… \| NOT IN SKYFLY (reason)` | the page's original "Order Received" box |
| Skyfly and the Sheet both down | nothing | nothing | error message, details kept, can retry |

**No duplicates:** a Sheet row marked `Skyfly LR-…` is the same order as in Skyfly, so process
it in Skyfly only. Rows marked `NOT IN SKYFLY` are the only ones to handle from the Sheet.
Retries and double taps never create a second Skyfly order. Rarely, a customer going back
and resubmitting adds a second Sheet row with the **same** reference; it is the same order.

When Skyfly has received real orders reliably for a few days, switch the fallback off:
change `SKYFLY_SHEET_FALLBACK=true` to `false` in the page (one line). To stop sending Sheet
copies too, delete the line `await skySheet(order,'Skyfly '+data.reference,1500);`.

## Applying it

Apply this only after `https://skyfly.onrender.com/healthz` shows `{"status":"ok"}` **and** the
Larose business has been set up in Skyfly (`npm run seed:larose -- your-email` in Render's Shell),
because Skyfly only accepts orders for the registered form key `larosenigeria`.
(If you apply it earlier, orders simply fall back to the Google Sheet.)

The ready-made patched page is generated with:

```sh
python3 integrations/larosenigeria/patch.py <original index.html> <output index.html> https://skyfly.onrender.com
```

Upload the result as `index.html` in the `Larosenigeria` repository (GitHub → Larosenigeria →
Add file → Upload files → commit to `main`). GitHub Pages republishes in about a minute. The page
address and design stay the same. `landing-page.diff` shows exactly what changes.

Then place one real test order on the live page and check:
1. you land on the Skyfly confirmation page with an `LR-…` reference;
2. the order appears in Skyfly → Orders (mark it as a **test order**);
3. the Sheet has a row whose source ends with that `Skyfly LR-…` reference;
4. Skyfly → Pages shows the Larose page as **Orders connected ✓ verified**.

## Keeping prices in sync

Skyfly's **Products** page is the source of truth for prices. If you change a
price in Skyfly, update the same price on the landing page too. Until you do,
Skyfly refuses orders for that package and asks the customer to refresh, so
nobody is charged a different price from the one they saw.
