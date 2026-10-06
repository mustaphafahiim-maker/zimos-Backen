# Domain registrar — adapter contract

"Buy a domain" in the dashboard (spec-gaps item 176): search a name, buy it, and the
store is connected to it with no DNS work by the merchant; it renews itself.

## Interface (`index.js`)

| Call | Returns |
|---|---|
| `search(domains[])` | `[{ domain, available, price: { amount, currency } \| null, renewalPrice }]` — minor units, from the registrar |
| `register({ domain, years, contact })` | `{ providerRef, expiresAt }` |
| `setRecords({ domain, providerRef, records })` | — records `[{ type: 'A' \| 'CNAME' \| 'ALIAS' \| 'TXT', name, value }]` |
| `renew({ domain, providerRef, years, expiresAt })` | `{ expiresAt }` |

Prices are never written in our code: they come from the registrar's answer
(or, in the sandbox, from `DOMAIN_SANDBOX_PRICES`). A purchase sends back the price
the merchant was shown (`acceptPrice`); if the registrar now quotes another, the
purchase stops with 409 `DOMAIN_PRICE_CHANGED`.

## Adapters

| `DOMAIN_REGISTRAR` | |
|---|---|
| `sandbox` (default) | Availability from a real NS lookup (a name with name servers is taken; "taken" in the name is taken). Prices from `DOMAIN_SANDBOX_PRICES` (JSON per TLD), else null. Register / DNS / renew only log. |
| a real registrar (to add) | Needs the owner's reseller account (e.g. Namecheap, Cloudflare Registrar, OpenSRS). Map the four calls above; keep its API key sealed in env. |

## Who pays

Charging the merchant for the domain is the billing team's (Fawaterak invoices, SPEC §22);
nothing here takes money. In the sandbox nothing is bought.

## What the platform does after `register`

1. Records the purchase (`domain_purchases`).
2. Adds the domain to the store (`domains`), marks it verified (we hold its DNS).
3. Sets the routing records (`rootDomains.routingFor`) and the verification TXT through `setRecords`.
4. The daily job `domains.renew_due` renews purchases with auto-renew on that expire within 30 days.
