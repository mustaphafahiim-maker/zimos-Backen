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
| `getRecords({ domain, providerRef })` (optional, item 385) | `[{ type, name, value, ttl, priority? }]` — the whole zone, names in full, MX with `priority` |
| `unlock({ domain, providerRef })` (optional, item 385) | — turns the registrar lock off so the domain can be transferred |
| `authCode({ domain, providerRef })` (optional, item 385) | `{ authCode }` — the transfer (EPP) code; never logged, never stored |

`setRecords` also takes MX records (`{ type: 'MX', name, value, priority }`) since item 385.

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
| `dynadot` (item 326, the owner's pick) | Dynadot API3, JSON. See below. |
| `namecheap` (item 327, the fallback) | Namecheap XML API. See below. |

Not used, and why (research 2026-10-07): **Hostinger** forbids reselling in its terms. **Cloudflare
Registrar**'s API is beta and cannot renew yet. **Namecheap** works, but its API prices are retail, so a
.com renewal costs more than we would sell it for. It is the fallback (item 327).

## Dynadot (`DOMAIN_REGISTRAR=dynadot`)

| Env | |
|---|---|
| `DYNADOT_API_KEY` | The account's API key (Tools → API). Never logged: the key travels in the URL, so only the command name is logged. |
| `DYNADOT_API_URL` | Default `https://api.dynadot.com/api3.json`. For the sandbox key use `https://api-sandbox.dynadot.com/api3.json`. |
| `DYNADOT_CURRENCY` | The account's currency, default `USD`. |
| `PLATFORM_APEX_IPS` | **Required.** Dynadot has no ALIAS record, so a root domain is pointed with A records. Without it buying is 503 `DOMAIN_PURCHASE_UNAVAILABLE`, before anything is bought. |

**How each step works:**
- **Calls:** `search` (with `show_price`, all names in one call), `tld_price` (renewal price per TLD, cached for an hour), `create_contact` then `register`, `set_dns2` and `renew`.
- **Ownership:** the merchant's details become the domain's registrant contact, so they own the domain. Admin, tech and billing stay the account's defaults.
- **DNS:** `set_dns2` replaces the zone, and we send the whole set: the root's A records, the `www` CNAME and the verification TXT.
- **Premium names** are never sold.
- **One call at a time:** Dynadot temporarily bans accounts that send API3 calls in parallel. Every call waits for the one before it in this process, so run the daily `domains.renew_due` job on one worker.
- **Errors:** a refusal answers 502 `REGISTRAR_REFUSED`, with Dynadot's message. No answer gives 502 `REGISTRAR_UNAVAILABLE`.

**Owner's setup:**
1. Open a new Dynadot account in the company's name, with no domains in it.
2. Apply for the free reseller account.
3. Verify identity and phone, and turn on two-step login.
4. Top up in USD (Payoneer, Wise or a USD card; Egyptian cards have foreign-currency limits).
5. Tools → API: create a live key and a sandbox key. Add the server's fixed IP if asked.
6. Put the keys in the server's environment, never in chat.

**Before going live**, run this against the sandbox. The adapter was written from the API3 documentation and tested against a stand-in, because Dynadot's site could not be reached from where it was built.
1. Search a free name and a taken one. Prices must come back as "10.88 in USD"-style text.
2. Buy a name with a registrant. The registrant must show on the domain, and the zone must hold the A, www and TXT records (the TXT on `_zimos-verify.<domain>`, item 341).
3. Renew it. The new expiry must come back.
4. Read `tld_price`: the renew price per TLD must be found. If the answer is nested differently, adjust `tldPrices()`.

## Namecheap (`DOMAIN_REGISTRAR=namecheap`)

| Env | |
|---|---|
| `NAMECHEAP_API_USER` / `NAMECHEAP_API_KEY` | Profile → Tools → Business & Dev Tools → Namecheap API Access. The key is never logged. |
| `NAMECHEAP_USERNAME` | The account the domains go to. Default: the API user. |
| `NAMECHEAP_CLIENT_IP` | **Required:** the server's fixed IPv4, whitelisted in the API settings. Namecheap only answers calls from it, and the IP declared must be the real source. |
| `NAMECHEAP_SANDBOX` | `true` uses `api.sandbox.namecheap.com`, a separate free account at sandbox.namecheap.com. `NAMECHEAP_API_URL` overrides the address. |
| `NAMECHEAP_ADMIN_CONTACT` | Optional JSON (same fields as the registrant) for the admin, tech and billing contacts. Without it the merchant is all four. |

**How each step works:**
- **Calls:** `domains.check`; `users.getPricing` per TLD and action (the account's own price plus the ICANN fee, cached for an hour as Namecheap asks); `domains.create` with free WHOIS privacy; `domains.dns.setDefault` then `domains.dns.setHosts`; and `domains.renew`.
- **DNS:** setHosts **replaces the whole host list**, so every write sends every record. ALIAS is supported, so `PLATFORM_APEX_IPS` is optional here.
- **Premium names** are never sold.

**API access needs** one of: 20+ domains in the account, a $50 balance, or $50 spent in two years.

**Prices:** API prices are retail, and a .com renewal costs about $18.5. With the same margin the renewal price is much higher than the purchase price; this is why Namecheap is only the fallback.

**Before going live**, run the same sandbox checklist as for Dynadot. The XML answers were mocked from Namecheap's API documentation.

## DNS records and transfer-out (item 385, `../purchaseDns.js`)

**DNS records.** `GET /purchases/:id/dns-records` reads the zone (`getRecords`) and lists every record.
ZIMOS's own records are `locked` while the domain is connected to the store: the root's A or ALIAS
(`purpose: routing`), the www CNAME when www is sent to the domain (`redirect`) and the TXT on
`_zimos-verify.<domain>` (`verification`). `present: false` means it is not in the zone yet, and
the next save writes it. `PUT` takes the merchant's records only: A, AAAA, CNAME, MX (with
`priority` 0–65535) and TXT, up to 50. They are checked (addresses, host names, no CNAME on the
root or beside another record, nothing on our names, no duplicates). Then the **whole zone** is
written, our records and theirs, because `set_dns2` and `setHosts` replace the zone. A locked
record is never removed or changed by a save. Records of a type we can't write back (forwarding,
SRV, CAA…) make the save stop with 409 `DNS_RECORDS_UNSUPPORTED`, so nothing is lost. If the
platform has since moved to another registrar, the answer is 409 `DOMAIN_REGISTRAR_CHANGED`. If
the registrar has no `getRecords`, the answer is 501 `DOMAIN_DNS_UNSUPPORTED`. Once the domain is
removed from the store nothing is locked any more: every record is the merchant's.

**Sending-domain records.** If the store set up its email sending domain
(`emailDomains/sendingDomain.js`) on the bought name, or on a name under it, its SPF, DKIM,
return-path and DMARC records are written into the zone at purchase. They are the merchant's
records (`purpose: email_spf` etc.), not locked. A sending domain set up after the purchase is
added to the zone in the same way. An SPF or DMARC record the merchant already has on that name is
kept (one per name). An older DKIM on the same name is replaced.

**Transfer-out.** `POST /purchases/:id/transfer-code` is for the store owner only (403
`NOT_STORE_OWNER`), with their password, at most 5 tries an hour per account. It calls `unlock`
then `authCode` and returns the code in that one answer (`Cache-Control: no-store`). The code is
not kept, not logged and not put in the audit entry `domain.transfer_code`. Auto-renew is
switched off and `transferUnlockedAt` is set. If the registrar can't give the code, the answer is
501 `DOMAIN_TRANSFER_UNSUPPORTED` before anything is changed.

| Registrar | getRecords | unlock | authCode |
|---|---|---|---|
| sandbox | the zone last written, kept in memory (empty after a restart) | in memory | made up, the same each time for a domain |
| Dynadot | `get_dns` (`NameServerSettings.MainDomains` / `SubDomains`; an MX's distance in `Value2`) | `get_transfer_auth_code` with `unlock_domain_for_transfer=1` | `get_transfer_auth_code` (`AuthCode`) |
| Namecheap | `domains.dns.getHosts` | `domains.setRegistrarLock` with `LockAction=UNLOCK` | **not implemented**: Namecheap's API has no command that returns the EPP code (the owner gets it from Namecheap's dashboard), so transfer-out answers 501 |

MX records are written with Dynadot's `main_recordx` / `sub_recordx` (the MX distance), and with
Namecheap's `MXPref` plus `EmailType=MX` (without it Namecheap ignores the MX hosts).

**Before going live, check against each sandbox.** Dynadot's site and docs could not be reached from
where this was built. The command and parameter names were checked against an open-source API3
client; the shapes of the answers were not checked and are read loosely.
1. `get_dns` on a bought domain: the records must come back with their names, and an MX with its distance. If not, adjust `getRecords()`.
2. `get_transfer_auth_code`: the code must be found under `AuthCode`, and the domain must show as unlocked afterwards.
3. Namecheap `getHosts` after a `setHosts` with an MX: the MX must be there with its `MXPref`.

## The domain's owner (registrant)

A real registrar needs the merchant's details as the domain's owner of record. The buy dialog asks for them once, `POST /purchases` sends them as `contact`, and they are kept in `workspace.settings.domain_registrant` for the next purchase. `GET /registrant` returns `{ required, contact }`. If a contact is required but none is given or saved, the answer is 422 `DOMAIN_CONTACT_REQUIRED`. ICANN then emails the registrant to confirm the address, and the domain is suspended if they don't confirm within 15 days.

A renewal with a real registrar needs a price, like a purchase (503 `DOMAIN_PRICE_UNAVAILABLE`). The daily automatic renewal still renews when it has no price, because losing the domain is worse; its audit entry then has `price: null`.

## Who pays

Charging the merchant for the domain is the billing team's (Fawaterak invoices, SPEC §22);
nothing here takes money — with a real registrar the platform's balance pays the registrar, and
billing invoices the merchant from `domain_purchases` (price) and the renewal audit entries. In the
sandbox nothing is bought.

## What the platform does after `register`

1. Records the purchase (`domain_purchases`).
2. Adds the domain to the store (`domains`), marks it verified (we hold its DNS).
3. Sets the routing records (`rootDomains.routingFor`) and the verification TXT through `setRecords`, with the store's sending-domain records when it has one on that name (item 385).
4. The daily job `domains.renew_due` renews purchases with auto-renew on that expire within 30 days.

## Order of checks (frontend request)

A purchase checks everything that could stop the store from using the domain
(store set up with a website, not a platform subdomain, the www/root not
connected elsewhere, plan limit, price) **before** `register`, so money is
never spent on a domain that then fails. A failure after `register` answers
502 `DOMAIN_CONNECT_FAILED` (bought, not yet connected), never "nothing was charged".
A root domain's www record is created with the others, and marked `dnsManaged`.
