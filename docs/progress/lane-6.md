# Lane 6 — Analytics, profit, payments and currencies

## Done
- [x] 1. Dashboard home KPIs (§15.1): `GET /analytics/overview` (all KPIs + previous period, per-day series, conversion funnel, offers table, top sources/governorates/devices/products/funnels, funnel filter) and the home page built on it (`pages/home/StoreOverview.tsx`) — checked on :4106 / :5206 with seeded orders and events, in English and Arabic.
- [x] 2. Sales attribution (§15.3): `GET /analytics/attribution` (group by source/medium/campaign/content, UTM and funnel filters, delivered column, spend/ROAS when ad spend exists) and `/analytics/attribution` page — checked on :5206 with seeded UTM traffic.

## Next
- [ ] 3. Real profit (§15.4): `product_economics`, `ad_spend_daily` (manual + CSV), P&L endpoint and page, campaigns screen, `ads.sync_spend` on a sandbox adapter.
- [ ] 4. Settlements (§15.5): import courier statement, match waybills, discrepancies, money held by couriers.
- [ ] 5. Payments: gateway adapter README + `sandbox` gateway; manual transfer with receipt image and confirm/reject (§11.3); deposits.
- [ ] 6. Payment rules (§11.4): fee/discount per method, gateways per funnel, failed-payment retry link.
- [ ] 7. Currencies (§11.5): `fx_rates`, sandbox rates adapter, display currencies, `fxRateToBase` on orders, currency switch in analytics.
- [ ] 8. Saved payment methods interface on the sandbox gateway (§11.6).
- [ ] 9. Realtime view updates over SSE (§15.2).

## Decisions
- 2026-10-03 Overview is computed with aggregate SQL per request, no `analytics_daily` table yet: the worker that would fill it is lane 7's; the queries only touch indexed ranges and never load rows into Node.
- 2026-10-03 Confirmation rate = confirmed COD ÷ COD orders (prepaid orders never get a call); delivery rate = delivered ÷ orders that left with a courier (derived stage).
- 2026-10-03 "New orders" uses lane 1's `isSeen` and test orders are excluded through `isTest` as soon as those columns exist on the Order model; until then new = pending confirmation.
- 2026-10-03 `netProfit` on the overview is delivered item revenue − cost − discounts − refunds until item 3 swaps in the full P&L.
- 2026-10-03 The home page keeps "Recent orders"; the old 30-day cards, quick stats, top products and funnels panels were replaced by the overview (same numbers, selectable period).
- 2026-10-03 `currency` is accepted by `/analytics/overview` and ignored until item 7 adds conversion.
- 2026-10-03 Lane API calls live in `packages/api-client/src/endpoints/insights.ts` (analytics/profit) — later `paymentsExtra.ts` for §11.

- 2026-10-03 Orders are attributed through the UTM values on their own `purchase` event (orders have no attribution column yet — lane 4 adds one); orders without a tracked purchase appear under "No UTM".

## Blocked

## Handoff
Item 1 landed. Scratch helpers used for checking (not in the repo): a seed script that fills `zimos_lane_6` with ~135 `L6-` orders, sessions and events over 21 days. Start item 2 next: attribution service next to `overviewService.js`, reusing its window helpers.
