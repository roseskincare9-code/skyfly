> **DRAFT — FOR LEGAL REVIEW. NOT FOR PUBLICATION.**
> Prepared 3 Nov 2026 from how Skyfly actually processes data, as a starting point for a qualified lawyer.
> Not legal advice. Items in [square brackets] must be completed. Points for counsel are marked **(Counsel:)**.

# Skyfly Privacy Policy

**Who we are:** [COMPANY LEGAL NAME], [registered address] ("Skyfly", "we"). **Contact / data protection
contact:** [privacy email]. **Version:** [date].
**(Counsel:** NDPA 2023 registration as a data controller/processor of major importance; whether a DPO
must be appointed; NDPC filing obligations.**)**

## 1. Two roles
- **Controller:** for the data of people who use Skyfly accounts (business owners and their teams).
- **Processor, on behalf of each business:** for the data of that business's customers (people who order
  through its pages). The business is the controller and decides why and how its customers' data is used.
  **(Counsel:** a data processing agreement / DPA clause in the Terms for this role.**)**

## 2. What we collect
| Who | Data | Source |
|---|---|---|
| Account users | name, email, phone, business name, hashed password (never the password), terms version and acceptance time, sign-in records, IP address, security events | registration, sign-in |
| Customers of businesses | name, phone, delivery address, state, optional email and notes, products ordered, totals, order status, marketing consent | the business's order forms and dashboard |
| Visitors to business pages | technical data and events (PageView, ViewContent, InitiateCheckout, Lead, Purchase) when the business has added tracking IDs | the page's tracking tags |
| Security | registration and sign-in attempt counts (stored only as hashes of email/IP), bot-check results | our servers, Cloudflare Turnstile |

## 3. Why we use it and lawful bases
- Provide accounts, workspaces and order handling (contract).
- Account emails: email verification, password reset, order notifications (contract or legitimate interest).
- Security, fraud and abuse prevention, including rate limits and bot checks (legitimate interest; legal obligation).
- Billing and records (contract; legal obligation).
- Marketing emails to a business's customers only where the business has recorded consent (consent).
**(Counsel:** confirm NDPA lawful bases and wording.**)**

## 4. Who receives it (sub-processors)
| Provider | Purpose | Location |
|---|---|---|
| Render | application hosting and database | EU (Frankfurt, Germany) |
| Resend | sending account and order emails | [confirm region] |
| Cloudflare | DNS, Turnstile bot check | global |
| Google (Sheets API) | copying a business's orders to its own spreadsheet, when connected | global |
| Meta, TikTok, X | advertising events, only for tracking IDs a business adds | global |
| GitHub | encrypted database backups (Actions artifacts, kept 30 days) | global |
We do not sell personal data. **(Counsel:** NDPA cross-border transfer conditions and adequacy; sub-processor notice.**)**

## 5. Retention
- Account data: while the account is active, then [period] after closure.
- Order and customer records: while the business's account is active, or as the business instructs; then [period].
- Security records: sign-in attempt hashes about 2 days; activity log [period].
- Backups: encrypted daily backups kept 30 days.

## 6. Security
Workspace isolation is enforced on the server and in the database. Connections use HTTPS. Passwords are
hashed. Stored integration secrets are encrypted. Backups are encrypted (AES-256). Administrator access
to a workspace is logged. We will notify the NDPC and affected people of personal data breaches as the
law requires. **(Counsel:** 72-hour breach notification under NDPA.**)**

## 7. Your rights
You may ask to access, correct, delete or receive a copy of your personal data, object to or restrict
processing, and withdraw consent, by contacting [privacy email]. Customers of a business should contact
that business first; we will help it respond. You may complain to the Nigeria Data Protection Commission.

## 8. Cookies
We use a strictly necessary session cookie (sign-in, security). Tracking tags on business pages are
controlled by each business. **(Counsel:** cookie consent requirements for business pages.**)**

## 9. Changes
We will post updates here and tell account holders about material changes.
