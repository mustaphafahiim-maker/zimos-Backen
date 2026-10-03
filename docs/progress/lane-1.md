# Lane 1 — Orders and fulfilment

## Done
- [x] 1. `order_status_history` + transition guards — checked on :4101/:5201: a COD order walked new → follow up → new → ready → shipped → failed → out → delivered → returned through `PATCH /orders/:id/status`; `delivered → shipped` and a manual shipment patch `delivered → in_transit` both answer 409 `INVALID_STATUS_TRANSITION`; cancel + reopen; history rows carry actor and reason; the order page's "Change status" dialog and "Status history" card in Arabic and English.

## Next
- [ ] 2. Order fields (§4.2): `source`, `tags`, `isSeen`/`seenAt`, `isTest`, `archivedAt`; `order_notes` with internal/public visibility.
- [ ] 3. Order page (§4.4): notes card, tags, full timeline endpoint (`/orders/:id/timeline`), previous/next (`/neighbors`), copy customer link, archive, cancel reasons list, mark seen on open.
- [ ] 4. Orders list (§4.3): tag/source/payment/governorate/courier/seen filters, saved views, column chooser, page size.
- [ ] 5. Bulk actions (`POST /orders/bulk`): set stage where allowed, add/remove tag, archive, print waybills, book courier.
- [ ] 6. Manual order screen (§4.5) on the existing `POST /orders`.
- [ ] 7. Edit order items with price preview before shipping; refund by lines; `POST /orders/:id/fulfill`.
- [ ] 8. `POST /orders/import-tracking` (CSV), bulk waybill PDF (A4 ×4 and 10×15), courier manifest (§12.4).
- [ ] 9. Invoice PDF for an order; xlsx as a second export format.

## Decisions
- 2026-10-03 No `status` column (LANES §3). The spec's statuses map onto the derived stages: confirmed/paid/processing/awaiting_pickup → `ready_to_ship`; unreachable/postponed → `needs_follow_up`; in_delivery → `shipped`/`out_for_delivery`; payment_failed → `awaiting_payment`. No new stage was added.
- 2026-10-03 Customer return requests stay in the returns module (its own page and statuses); the order's stage only shows `returned` once the parcel is back. Adding `return_requested`/`return_in_progress` stages would put a second lateral join in every list query.
- 2026-10-03 History is written by `orderStateService.trackStage` (compare the stage with the last row, write on a difference), called from the three state setters, `transitionShipment`, order create/cancel, shipment create and the online-payment paths. Migration 135 gives every existing order a baseline row.
- 2026-10-03 The guard is enforced where a person asks for a move: `PATCH /orders/:id/status` and a shipment status typed by hand (`PATCH /orders/:id/shipments/:id`). Courier webhooks/sync are recorded, never refused.
- 2026-10-03 "Set stage" runs the existing operation that produces the stage (confirm from order page, confirmation outcome, shipment status, cancel) so stock, queue, courier and automations stay in step. A shipping stage on an order with no shipment creates a manual shipment (`carrierCode` from the request, default `manual`).
- 2026-10-03 Un-cancel ("reopen") re-reserves stock (409 `INSUFFICIENT_STOCK` if gone), clears the cancellation, sets confirmation back to pending and reopens the COD task; the request targets `pending_confirmation` and a prepaid order lands in `awaiting_payment` / `ready_to_ship`.
- 2026-10-03 `awaiting_payment → ready_to_ship` is not a manual move: payments are recorded by the gateway or the payments card.
- 2026-10-03 Frontend: lane-1 API calls live in `packages/api-client/src/endpoints/orders.ts`; lane-1 error wording in `pages/orders/orderErrors.ts` (the shared `ApiErrorCode` union is not extended).

## Blocked

## Handoff
- Branch `lane-1` in both worktrees; everything listed under Done is merged into `origin/zimos-additions`.
- Migrations used: 135. Next free: 136.
- Scratch helpers (not in the repo) were in the session scratchpad; recreate as needed: log in as `demo@zimos.test` against `http://localhost:4101/api/v1`, workspace from `GET /workspaces`.
- The lane database has a handful of demo COD orders created through `POST /orders`.
