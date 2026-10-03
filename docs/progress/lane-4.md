# Lane 4 — Marketing, messaging and notifications

## Done
- [x] 1. Merchant notifications (§14.6): `notifications` + `notification_preferences` (migration 210), bell drawer, read / read-all, new-order sound, per-user preferences — checked on :4104 by creating an order through `POST /orders` (got `order.new` + `stock.low`), then list / summary / read / read-all / preferences GET+PUT / validation 422. Dashboard typechecks (`tsc -b`); the bell and the settings section were NOT opened in the browser (see Blocked).

## Next
- [ ] 2. `tracking_pixels` table (§13.1): several pixels per platform, scope per funnel/product, CAPI token and test code per pixel; migrate `settings.tracking_pixels`; Marketing page as "Tracking tools" with add-pixel dialog, GTM/GA4/Clarity ID fields.
- [ ] 3. Events (§13.2): `add_payment_info`, `lead`, shared `event_id` browser↔server; pixel event log + "send test event".
- [ ] 4. Purchase timing setting (§13.3); order `attribution` and `sessionStats` (§13.4).
- [ ] 5. Automations (§14.2): ordered steps, new triggers, conditions, variables, delayed-step runner, Arabic templates.
- [ ] 6. WhatsApp quick-reply confirmation.
- [ ] 7. Inbox (§14.3): side panel, quick replies, assignment, filters, SSE.
- [ ] 8. Order emails (§14.5): templates, preview, test send.
- [ ] 9. WhatsApp campaigns to consenting contacts only (§14.4).
- [ ] 10. Customer tracking page polish (§14.7).

## Decisions
- 2026-10-03 Notifications are fanned out: one row per teammate (permission of the type + their preferences), so `readAt` is per person. `user_id` stays nullable as in the spec (a null row = whole team, shared read state).
- 2026-10-03 `/workspaces/:id/notifications` has no `requirePermission`: it is each member's own bell; the type's permission is applied at delivery. Marking read is not audited (noise); preference changes are.
- 2026-10-03 Channels built: `inApp` and `email` (existing provider). Web push / app / WhatsApp-to-merchant need providers that §14 puts out of scope.
- 2026-10-03 Title/body are stored in Arabic; `data` carries the values and the dashboard renders known types in the viewer's language.
- 2026-10-03 New-order sound is generated with Web Audio (no asset file); the header polls `/notifications/summary` every 20 s (SSE comes with item 7).
- 2026-10-03 Platform announcements are copied into a teammate's bell lazily when they list notifications (dedupe on announcement id).
- 2026-10-03 "Wallet running low" type skipped: there is no wallet (pricing is out of scope).
- 2026-10-03 Emitters wired: `order.created` (new order, suspicious when `riskFlags` is set, low stock of the ordered variants once a day). `integrationFailed()` and `exportReady()` exist in `merchantNotificationEvents.js` for other lanes to call; not yet called anywhere.
- 2026-10-03 The preview tool allows 5 dev servers per folder and 4 belong to other lanes, so the API is run with `node src/server.js` in the background and only the dashboard/storefront through `preview_start`.

## Blocked
- Browser check of dashboard screens — the owner declined the sign-in step in the browser pane (typing the demo password) on 2026-10-03. Until told otherwise, screens are verified by typecheck + the API only, not visually.

## Handoff
Item 1 landed. Branch `lane-4` in both repos is merged with `origin/zimos-additions` after each item. Helper scripts used for checks live only in the chat scratchpad (login + call API, SQL on `zimos_lane_4`); recreate if needed.
