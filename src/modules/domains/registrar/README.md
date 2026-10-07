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
| `renewQuote({ domain, providerRef, years })` (optional) | `{ amount, currency } \| null` — else `search`'s `renewalPrice` × years |

Prices are never written in our code: they come from the registrar's answer
(or, in the sandbox, from `DOMAIN_SANDBOX_PRICES`). A purchase sends back the price
the merchant was shown (`acceptPrice`); if the price is now another, the
purchase stops with 409 `DOMAIN_PRICE_CHANGED`.

## Selling price and margin (`pricing.js`, item 325)

The merchant sees and confirms the **selling price**: the registrar's cost, converted
to the platform's selling currency at the daily rate (`currencies/fxService`), plus the
platform's margin, rounded up. All three come from configuration:

| Env | |
|---|---|
| `DOMAIN_SELL_CURRENCY` | e.g. `EGP`. Unset: the registrar's own currency. |
| `DOMAIN_MARGIN_PERCENT` | 0–300, default 0. |
| `DOMAIN_PRICE_STEP` | minor units to round up to (e.g. `500` = whole 5 EGP), default 1. |

The purchase row keeps both: `price_amount`/`currency` (what the merchant was charged) and
`cost_amount`/`cost_currency` (the registrar's quote). Renewals (by hand: `domain.renew`;
automatic: `domain.auto_renew_done`) write both into their audit entry. With a real
registrar, a name with no price (no quote, or no exchange rate yet) cannot be bought:
503 `DOMAIN_PRICE_UNAVAILABLE`. The 409 compares selling prices, so a rate move that changes
the rounded price asks the merchant to confirm again.

## Adapters

| `DOMAIN_REGISTRAR` | |
|---|---|
| `sandbox` (default) | Availability from a real NS lookup (a name with name servers is taken; "taken" in the name is taken). Prices from `DOMAIN_SANDBOX_PRICES` (JSON per TLD), else null. Register / DNS / renew only log. |
| a real registrar (to add) | Needs the owner's reseller account (e.g. Namecheap, Cloudflare Registrar, OpenSRS). Map the four calls above; keep its API key sealed in env. |

## Who pays

Charging the merchant for the domain is the billing team's (Fawaterak invoices, SPEC §22);
nothing here takes money — with a real registrar the platform's balance pays the registrar, and
billing invoices the merchant from `domain_purchases` (price) and the renewal audit entries. In the
sandbox nothing is bought.

## What the platform does after `register`

1. Records the purchase (`domain_purchases`).
2. Adds the domain to the store (`domains`), marks it verified (we hold its DNS).
3. Sets the routing records (`rootDomains.routingFor`) and the verification TXT through `setRecords`.
4. The daily job `domains.renew_due` renews purchases with auto-renew on that expire within 30 days.

## Order of checks (frontend request)

A purchase checks everything that could stop the store from using the domain
(store set up with a website, not a platform subdomain, the www/root not
connected elsewhere, plan limit, price) **before** `register`, so money is
never spent on a domain that then fails. A failure after `register` answers
502 `DOMAIN_CONNECT_FAILED` (bought, not yet connected), never "nothing was charged".
A root domain's www record is created with the others, and marked `dnsManaged`.
