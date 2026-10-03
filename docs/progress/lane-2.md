# Lane 2 — Protection and lost orders

## Done
- [x] 1. `blocked_entries` (phone, ip, email, device, name+address; scopes orders/otp/visit) with list/add/delete/CSV import, linked both ways to the customer blacklist — migration 160, `modules/fraud/blockedEntries.js`, dashboard Fraud → Blocklist tab (`BlockedEntriesTab.tsx`), `endpoints/protection.ts`. Checked on :4102: add phone/ip/name+address, bad IP → 422, CSV import (3 in, 1 skipped with line number), filter by type, storefront order from a blocked phone gets `blacklisted_customer`, PATCH customer blacklist ↔ entry, DELETE entry un-blacklists the customer. Dashboard typechecked; the tab was not opened in a browser (see Decisions).
- [x] 2. Fraud rule keys of §5.2 with a per-rule action (`{ value, action }`, old bare values still read): max items per product, minutes between COD orders per IP, strict phone validation, allowed countries / VPN / delivery rate / high risk keys; orders now store `ipAddress` and `userAgent` (migration 161). Dashboard Fraud → Rules tab rewritten (`ProtectionRulesTab.tsx`). Checked on :4102: 4 units with max 3 + block → ORDER_REJECTED; landline with strict phone → INVALID_PHONE; second COD order from the same IP → `ip_order_rate` flag; bad action → 422. Dashboard typechecked.

## Next
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
- 2026-10-03 Stored fraud rules are not rewritten by a migration: `resolveFraudRules` reads both the bare value and `{ value, action }`, and the dashboard saves the new shape.
- 2026-10-03 Strict phone validation uses per-country mobile patterns in `fraudRules.js` (no libphonenumber in the repo); the store country comes from `defaultLocale`. It answers INVALID_PHONE so the shopper can fix the number.
- 2026-10-03 `block_outside_country`, `block_vpn`, `min_network_delivery_rate`, `high_risk` are validated, stored and evaluated already, but only fire once items 3, 5 and 6 pass them the IP country, VPN flag, network rate and risk level. `require_otp` only flags until item 7; `to_lost` refuses like block until item 9 files the lost order.

## Blocked

## Handoff
Items 1 and 2 are landed on zimos-additions (backend and frontend); nothing is half-done. Next is item 3: `modules/risk/ipIntel` (interface + sandbox adapter + README), fill `orders.ip_country` (column exists, migration 161) and pass `visitor: { ip, ipCountry, isVpn }` to `fraudRules.evaluateStorefrontOrder` in `orderService.createOrder` (it already takes them), then a public store check that hides the store from blocked countries and from `blocked_entries` of scope `visit`. Migrations used so far: 160, 161.

Working notes: only one preview server fits (other lanes hold 4 of 5), so run the API with `node src/server.js` in the background and verify through HTTP: log in as the demo user on :4102, workspace id from `GET /workspaces`, storefront checkout needs an `Idempotency-Key` header. Every merge conflicts in `packages/api-client/src/index.ts` (keep both lines); `orderService.js` and `workspaceValidation.js` are edited by other lanes too, so keep edits there to a few lines.
