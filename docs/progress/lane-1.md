# Lane 1 — Orders and fulfilment

## Done
- [x] 1. `order_status_history` + transition guards — backend cd915b8 / frontend 17a6f60 — checked on :4101/:5201: a COD order walked new → follow up → new → ready → shipped → failed → out → delivered → returned through `PATCH /orders/:id/status`; `delivered → shipped` and a manual shipment patch `delivered → in_transit` both answer 409 `INVALID_STATUS_TRANSITION`; cancel + reopen; history rows carry actor and reason; the order page's "Change status" dialog and "Status history" card in Arabic and English.
- [x] 2. Order fields (§4.2) + `order_notes` — migration 136 — backend 9336878 / frontend caad549 — checked on :4101: new order gets `source` (manual from the dashboard), `PATCH /orders/:id/meta` sets/adds/removes tags, test, seen, archive; `GET /orders/tags`; notes add/list/delete; list + pipeline + export accept `tag, source, paymentMethod, governorate, carrier, seen, test, archived` and hide archived orders by default; on :3201 the tracking page shows the public note and not the internal one.
- [x] 3. Order page (§4.4) — backend 4bb95aa / frontend 8fa81e7 — checked on :5201 in Arabic: added a note and a tag, read them in the timeline with the status moves, archive + restore, cancel dialog lists the five reasons, the next arrow opens the next order of the list, source badge shown; `timeline` and `neighbors` also run against the lane database.
- [x] 4. Orders list (§4.3) — checked on :5201: `?tag=&source=` filters the rows and the tab counts and shows removable chips, the column chooser adds Tags / Source / Governorate, page size 25/50/100 is remembered, a saved view is stored and re-applied, unseen orders show a dot and bold number.

## Next
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
- 2026-10-03 `isTest` is set when a storefront order carries a valid `X-Store-Preview` token (staff previewing their store) or by hand; test orders send no ad pixel and are excluded by `countsAsSaleSql`. `source`: staff → manual, API key → api, funnel id → funnel, follow-on funnel order → upsell, else store.
- 2026-10-03 One endpoint for tags/seen/test/archive (`PATCH /orders/:id/meta`) instead of four; a body of only `isSeen` needs `orders.view`, the rest `orders.manage`. Marking seen does not touch `updated_at` and is not audited.
- 2026-10-03 The list filters of item 4 were built with item 2 in `orders/orderFilters.js` (shared by list, counts, export). Archive = hidden from lists unless `archived=only|include`; nothing is deleted.
- 2026-10-03 Storefront strings for lane-1 additions live beside their component (`TrackOrderNotes.tsx`), not in the shared `lib/i18n.ts`.
- 2026-10-03 Timeline is assembled per request (status history + audit log of the order and its shipments + notes + automation runs + webhook deliveries); audit rows the status rows already tell (create, cancel, reopen, shipment status moves) are left out.
- 2026-10-03 Previous/next follow the list the merchant came from: the list stores its query in sessionStorage and the order page sends it to `/neighbors`.
- 2026-10-03 Cancel reasons are a list in the dialog (customer cancelled, fake, duplicate, out of stock, other); the stored reason is the chosen label in the merchant's language plus any details.
- 2026-10-03 Saved views, chosen columns and page size are kept in localStorage per workspace on the device (no table): a view is just the list's URL query under a name. A server-side per-user store can replace it without changing the screen.
- 2026-10-03 Frontend: lane-1 API calls live in `packages/api-client/src/endpoints/orders.ts`; lane-1 error wording in `pages/orders/orderErrors.ts` (the shared `ApiErrorCode` union is not extended).

## Blocked

## Handoff
- Branch `lane-1` in both worktrees; everything listed under Done is merged into `origin/zimos-additions`.
- Migrations used: 135, 136. Next free: 137.
- Dev servers: at most 5 per folder across all lanes — stop the dashboard before starting the storefront. The demo user's username is already set in `zimos_lane_1`.
- Never put backticks inside a double-quoted `node -e "..."` in Git Bash (they run as commands and hang); write the script to a file. `git merge` needs `--no-edit`.
- Scratch helpers are not in the repo: log in as `demo@zimos.test` on `http://localhost:4101/api/v1`, workspace from `GET /workspaces`, orders through `POST /workspaces/:id/orders` with an `Idempotency-Key` header.
