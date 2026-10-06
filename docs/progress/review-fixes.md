# Review fixes (2026-10-03)

Fixes from a whole-system review, each verified on a fresh database by running
the API. Not a lane: no migrations, no new routes.

## Done

- [x] Checkout under load: `calculateTax` and `discountService.evaluate` take
  the caller's `transaction`; order creation, upsell repricing and order item
  edits pass it. Before: 30 simultaneous checkouts → 20–21 failed (500,
  "Operation timeout" after 30 s, pool of 10). After: 30/30 in 2.4 s, 100/100
  in 4.7 s.
- [x] `REDIS_URL`: `bullmq`, `ioredis`, `rate-limit-redis` added. The Redis
  rate-limit store no longer fails its script load at boot (which let every
  request through unlimited). Verified with Redis 7: limits hit, jobs complete.
- [x] Dashboard rate limit counted per signed-in user (verified token), by IP
  otherwise.
- [x] Body-parser errors keep their status: 400 `INVALID_JSON`, 413
  `PAYLOAD_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE` (was 500).
- [x] Campaigns removed (owner, 2026-10-03): WhatsApp campaigns gone from backend and dashboard; STOP still withdraws marketing consent (`whatsapp/optOut.js`). "Ad campaigns" kept as "Ad spend" under Profit, because the P&L subtracts it. SPEC §10.10, §14.4, §21, §22 and LANES lane 4 item 9 updated in both repos.

## Decisions

- The `whatsapp_campaigns` and `whatsapp_campaign_recipients` tables (migration 218) are left in place: migrations are additive only. The owner can drop them later.
- Any new query inside an open transaction passes `{ transaction }`. A query
  without it takes a second pooled connection while the first is held, and a
  burst of requests then starves the pool.
- Kept the original `package-lock.json` and added only the new packages, so
  the Windows machine's `libc` fields are not churned.

## Not done (found in the review, left for the owner)

- Public review endpoint: a phone number is the only proof of identity
  (`reviewService.js`).
- Affiliate pages reconcile up to 2000 orders on every view
  (`affiliateService.js`, `commissionService.js`).
- Storefront `<html lang="en" dir="ltr">` on Arabic stores
  (frontend `apps/storefront/src/app/layout.tsx`).
- `server.js` logs "listening" even when the port is taken (Express 5 passes
  the error to the `listen` callback).
