# Import: {{NAME}}

**Package:** `{{SLUG}}.zip` · **Type:** course page ("Book Your Seat — ₦3,000")

## What changed
- Nothing in the design or content.

## Ordering: decision needed
The "Book Your Seat — ₦3,000" button links to `#` (it does not go anywhere today), and the page has no form.
It also has its own Meta Pixel (2189120765250980), separate from Larose's.
To take bookings in Skyfly it needs a booking form and a "seat" product at ₦3,000 in its own Skyfly business.
Tell me whether seats should be booked through Skyfly (pay later) or through a payment link, and I will prepare it.

## Import
1. Create a business for the academy (currency NGN) → **Pages** → **Import a landing page** → upload `{{SLUG}}.zip` → **Import as draft**.
2. Add its Meta Pixel in that business's **Pixels** screen if you want Skyfly to manage it.
3. Preview and publish need `PAGES_BASE_URL` on the Skyfly service.

## Requirements
- No secrets. External services: Google Fonts (if used), Meta Pixel.
