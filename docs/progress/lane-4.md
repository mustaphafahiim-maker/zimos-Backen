# Lane 4 — Marketing, messaging and notifications

## Done
- [x] 1. Merchant notifications (§14.6): `notifications` + `notification_preferences` (migration 210), bell drawer, read / read-all, new-order sound, per-user preferences — checked on :4104 by creating an order through `POST /orders` (got `order.new` + `stock.low`), then list / summary / read / read-all / preferences GET+PUT / validation 422. Dashboard typechecks (`tsc -b`); the bell and the settings section were NOT opened in the browser (see Blocked).
- [x] 2. `tracking_pixels` table (§13.1, migration 211) with several pixels per platform, scope (store / funnels / products), CAPI token + test code per pixel; old `settings.tracking_pixels` + `server_pixels` tokens copied over; `/tracking-pixels` CRUD; server Purchase goes to every in-scope CAPI pixel; storefront loads all pixels incl. GTM and Clarity; Marketing page is now "Tracking tools" with the add/edit dialog — checked on :4104: create/duplicate 409/bad id 422/missing token 422/foreign scope 422/patch/delete, `GET /store/:ws` returns `trackingPixels`, and an order reached Meta through the product-scoped pixel (fake token → auth error stored in `last_error`). Dashboard and storefront typecheck; neither screen was opened in a browser (see Blocked).

## Next
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
- 2026-10-03 Pixels: GTM and Clarity are rows of the same table (platforms `gtm`, `clarity`, browser only); a Google Ads id (`AW-`) carries `config.adsConversionLabel` and has no server API. TikTok/Snap/GA4 have no test-code field because their existing providers do not send one.
- 2026-10-03 The legacy `settings.tracking_pixels` key and `/server-pixels` endpoints are left in place but nothing reads them any more; `GET /store/:ws` still returns the old `tracking` block (first store-wide pixel per platform) next to the new `trackingPixels`.
- 2026-10-03 Storefront scoping: all pixels are initialised, events go only to in-scope pixels (Meta `trackSingle`, TikTok `instance`, gtag `send_to`). A product-scoped pixel joins the visit once that product page was viewed (sessionStorage); funnel scope follows the analytics tracking context. Snap cannot target one pixel, so a scoped Snap pixel is initialised on first match and stays for the page session.
- 2026-10-03 `pages/marketing/MarketingPage.test.tsx` still describes the old one-ID-per-platform form and will fail; left untouched (no test work in lanes) — whoever revives the suite should rewrite or drop it.

## Blocked
- Storefront dev server (:3204) answers 500 on this machine: Next cannot download Google Fonts (fonts.gstatic.com times out), unrelated to lane code. Storefront changes are verified by typecheck and the API payload only.
- All 5 preview-server slots of the folder are held by other lanes, so `preview_start` fails for lane 4; servers are run with node in the background instead and stopped after each check.
- Browser check of dashboard screens — the owner declined the sign-in step in the browser pane (typing the demo password) on 2026-10-03. Until told otherwise, screens are verified by typecheck + the API only, not visually.

## Handoff
Items 1–2 landed. Branch `lane-4` in both repos is merged with `origin/zimos-additions` after each item. Helper scripts used for checks live only in the chat scratchpad (login + call API, SQL on `zimos_lane_4`); recreate if needed.
