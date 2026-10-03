# Lane 2 — Protection and lost orders

## Done
- [x] 1. `blocked_entries` (phone, ip, email, device, name+address; scopes orders/otp/visit) with list/add/delete/CSV import, linked both ways to the customer blacklist — migration 160, `modules/fraud/blockedEntries.js`, dashboard Fraud → Blocklist tab (`BlockedEntriesTab.tsx`), `endpoints/protection.ts`. Checked on :4102: add phone/ip/name+address, bad IP → 422, CSV import (3 in, 1 skipped with line number), filter by type, storefront order from a blocked phone gets `blacklisted_customer`, PATCH customer blacklist ↔ entry, DELETE entry un-blacklists the customer. Dashboard typechecked; the tab was not opened in a browser (see Decisions).

## Next
- [ ] 2. Fraud rule keys of §5.2 with a per-rule action: max items, minutes between COD orders per IP, strict phone validation, allowed countries.
- [ ] 3. `ipIntel` interface + sandbox adapter + README; order `ipAddress`, `ipCountry`, `userAgent`; blocked countries and IPs for visitors.
- [ ] 4. Bot protection: honeypot + server-signed time token; Turnstile interface with a sandbox verifier.
- [ ] 5. `riskService.score` → `riskLevel`, `riskScore`, `dataQuality`; risk tabs/badges in the orders list.
- [ ] 6. `customer_network_stats` + delivery-rate bar + `GET /customers/:id/network-score`, behind a FeatureFlag.
- [ ] 7. Checkout OTP (§5.6) with the code-entry step in the storefront.
- [ ] 8. Fraud page: per-rule actions, "block and cancel", blocked tab with types, statistics tab.
- [ ] 9. Lost orders (§6).

## Decisions
- 2026-10-03 Blocklist routes keep `customers.view` / `customers.manage` (as the existing blocklist did) instead of a new permission: existing roles in the database would not have a new one.
- 2026-10-03 `POST /fraud/blocklist` still accepts the old `{ phone, reason }` body; `GET` now returns `{ entries, nextCursor, counts }` of blocked entries. A blocked phone no longer creates a customer row; order creation reads `blocked_entries` directly and marks the customer on its first order.
- 2026-10-03 A `name_address` entry stores sha256(normalized name | normalized street line); the label keeps the readable text.
- 2026-10-03 CSV import takes the file's text in a JSON body (`{ csv }`, 1.5 MB max, 2000 rows): no multipart needed.
- 2026-10-03 An `orders` entry match adds the existing `blacklisted_customer` flag (and refuses when `block_blacklisted` is on); staff-created orders are not matched by IP.
- 2026-10-03 The machine allows 5 preview servers per folder and other lanes hold 4, so the lane API runs with `node src/server.js` in the background and features are verified through the API; the owner declined browser-pane use in this chat, so dashboard screens are typechecked, not clicked.

## Blocked

## Handoff
Item 1 is landed. Nothing half-done. Test helper used so far (not in the repo): log in as the demo user on :4102, workspace id from `GET /workspaces`; storefront checkout needs an `Idempotency-Key` header.
