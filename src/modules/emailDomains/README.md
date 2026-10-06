# Sending domain for customer emails — provider contract

A store can send its customer emails (order emails, cart recovery) from its own
domain, e.g. `orders@ahmedstore.com`, instead of the platform's address. The store
adds DNS records, presses "Verify", and once verified `notify.email` sends its
order emails with that From address. Until then the platform's address is used
with the store's name and Reply-To (`notifications/orderEmailSender.js`).

## Interface (`providers.js`)

| Call | Returns |
|---|---|
| `addDomain(domain)` | `{ providerRef, records: [{ purpose, type, name, value }] }` |
| `verify({ domain, providerRef, records })` | `{ verified, records: [{ …record, ok }] }` |
| `removeDomain({ domain, providerRef })` | nothing |

`purpose` is `spf`, `dkim`, `return_path` or `dmarc`; DMARC is shown as advised and does
not block verification.

## Adapters

| `EMAIL_DOMAIN_PROVIDER` | |
|---|---|
| `sandbox` (default) | Hands out SPF/DKIM/return-path/DMARC records and checks them with real DNS lookups. Registers nothing, signs nothing. `.test`, `.example`, `.invalid`, `.localhost` domains always verify. |
| `brevo` (to add) | `POST /v3/senders/domains` (records in `dns_records`), `PUT /v3/senders/domains/{domain}/authenticate`, `DELETE /v3/senders/domains/{domain}`, with the platform's `BREVO_API_KEY`. Needs checking against the owner's Brevo account first. |

## Rules

- One domain per store; a domain is refused when another store already uses it.
- Sending from the domain starts only when it is verified, and stops when it is removed or a later check fails.
- The local part (`orders` by default) is the store's choice: letters, digits, `.`, `_`, `-`.
