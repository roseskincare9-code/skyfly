# Online payments (Stripe + PayPal): one-time platform setup

Each business connects **its own** Stripe and PayPal account from its dashboard (Payment Gateways). Money goes
straight to that business's account. Skyfly stores only the account identifier (`acct_…`, PayPal merchant ID);
no merchant secret key, password or card data is stored anywhere.

Before any business can connect, the platform itself needs these credentials **once**, set as environment
variables on Render → `skyfly` → Environment (never in the code, never in chat). Until they are set, the
Payment Gateways page shows "Not available yet" and checkout offers Payment on Delivery only.

## 1. Stripe Connect (Standard accounts, OAuth)

1. In the Stripe Dashboard of Skyfly's **own** Stripe account: Settings → Connect → enable Connect for a
   **platform**, with **Standard** accounts and OAuth.
2. Connect → Settings → **Redirects**: add `https://getskyfly.com/payments/stripe/callback`.
3. Developers → **Webhooks** → Add endpoint: `https://getskyfly.com/webhooks/stripe`, with
   "Listen to events on **Connected accounts**", events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
4. Render environment variables:

| Variable | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Developers → API keys → Secret key (`sk_test_…` for testing, `sk_live_…` for live) |
| `STRIPE_CONNECT_CLIENT_ID` | Settings → Connect → Onboarding options → OAuth → client ID (`ca_…`; test and live differ) |
| `STRIPE_WEBHOOK_SECRET` | The webhook endpoint from step 3 → Signing secret (`whsec_…`) |

The mode (test / live) follows the secret key. A business connected in test mode cannot take live payments
(and vice versa): it reconnects once after the switch.

## 2. PayPal (partner onboarding)

1. developer.paypal.com → Apps & Credentials → create a **REST app** for Skyfly (Sandbox first).
2. PayPal → Webhooks for that app: `https://getskyfly.com/webhooks/paypal`, events
   `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`,
   `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`.
3. **Live only:** onboarding merchants on PayPal's partner programme (Partner Referrals, "third-party"
   payments) requires PayPal to approve Skyfly as a partner. Apply through PayPal's partner programme with the
   live REST app; Sandbox works without approval.
4. Render environment variables:

| Variable | Where it comes from |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | The REST app (Sandbox or Live) |
| `PAYPAL_PARTNER_MERCHANT_ID` | Skyfly's own PayPal business account → Account settings → Merchant ID |
| `PAYPAL_WEBHOOK_ID` | The webhook from step 2 → Webhook ID |
| `PAYPAL_ENV` | `sandbox` (default) or `live` |
| `PAYPAL_BN_CODE` | Optional: the partner attribution ID PayPal gives approved partners |

## 3. Going live

1. Test everything with Stripe test keys and PayPal Sandbox: connect a test account for two businesses,
   pay a USD order with each gateway, a declined payment, a refund (see `test/payments.test.js`).
2. Replace the test values with live ones on Render (Stripe `sk_live_…` + live `ca_…` + live webhook
   secret; PayPal live app + `PAYPAL_ENV=live`). Each business then clicks **Reconnect**.

## How a payment is confirmed

- The order is saved first (USD, "Payment pending"), then the customer pays on Stripe's / PayPal's own page.
- It becomes **Paid** only from Stripe's signed webhook, PayPal's capture answer or PayPal's verified webhook,
  or Skyfly asking the gateway directly (return page, "Check payment status", reconciliation every few
  minutes). The amount, USD currency and receiving account must match Skyfly's record.
- A repeated webhook is recognised and changes nothing. Owners cannot set an online order's payment status by
  hand. Failed or abandoned payments keep the order as "Payment failed"; the customer can pay again from
  the confirmation page.
- Products need a USD price (Products → "Online price in USD") to be payable online; each business sets its
  own USD delivery fee (Payment Gateways). Nothing is ever converted from Naira.

## Skyfly's own plans (Business Pro ₦199,000 / Agency VIP ₦399,000 a month): Paystack

Owners pay for their plan on Paystack's checkout (Subscription page → Pay). The plan is switched on only
when Paystack confirms the payment to Skyfly (server-side verify or a signed webhook) for the exact amount.

| Setting (Render → skyfly → Environment) | Where to find it |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → Settings → API Keys & Webhooks → Secret key (`sk_test_…` for testing, `sk_live_…` for real payments) |

On the same Paystack page, set **Webhook URL** to `https://getskyfly.com/webhooks/paystack`.
Without the key the pricing and subscription pages say online payment is not on, and nothing is charged.
