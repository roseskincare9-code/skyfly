> **DRAFT — FOR LEGAL REVIEW. NOT FOR PUBLICATION.** Prepared 3 Nov 2026 from how Skyfly stores data today. Not legal advice. Periods in [brackets] need a decision.

# Skyfly Data Retention Policy

| Data | Kept | Then |
|---|---|---|
| Account (name, email, phone, password hash, terms acceptance) | While active | [12 months] after closure, then deleted or anonymised |
| Business data (products, pages, orders, customers, contacts) | While the business account is active | Export offered; deleted [90 days] after closure unless the law requires longer |
| Orders and invoices needed for tax/accounting | [6 years] **(Counsel:** Nigerian tax record rules.**)** | Deleted or anonymised |
| Activity/audit log | [24 months] | Deleted |
| Sign-in attempt counters (hashed) | About 2 days | Deleted automatically |
| One-time links (verification, reset, invitations) | Until used or expired (48 h / 1 h / 14 days) | Unusable after; cleaned up periodically |
| Sessions | 14 days | Expire automatically |
| Encrypted daily backups | 30 days (GitHub Actions artifacts) | Deleted automatically |
| Marketing consent and unsubscribes | While the contact exists | Unsubscribes kept to keep honouring them |

## Requests
Users ask for a copy or deletion from **Account → Your data**. Requests are recorded and handled by a Super Admin; nothing is deleted automatically. Business owners export their orders and contacts themselves.

## Not implemented yet (needs a decision first)
Automatic deletion after the periods above. Until decided, data is kept and deletion is done on request by a Super Admin.
