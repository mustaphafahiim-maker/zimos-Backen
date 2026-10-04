# SPEC gaps — the work queue (from 2026-10-03)

What docs/SPEC.md asks for that the code does not do yet, found by comparing
each section with the backend routes, the api-client and the screens. The
lanes' own progress files tick everything; these are the gaps behind the ticks.
Worked top to bottom on `claude/gracious-cori-p3g4hr`, one feature per commit,
verified by running it on a scratch database. Migrations for this queue use
the numbers **400–449** (no lane owns them).

## Decisions

- Marketing = `checkout.abandoned`, `lost_order.created`, `review.request`, `lead.created` (automations/marketingGuard.js). Order updates still go to a phone that said STOP: the customer asked for them by ordering.
- A STOP is stored per phone in `marketing_opt_outs`, not on customers: an abandoned checkout has no customer row. A newsletter sign-up by that phone removes it; a staff edit of the customer does not.
- A marketing SMS gets "للإيقاف أرسل: إيقاف" appended unless it already says how to stop. WhatsApp template texts carry it in their body. Email has no unsubscribe link yet (no email reply handling).
- The sandbox courier exists outside production for every store; in production only with `CARRIERS_SANDBOX=true` and the FeatureFlag `sandbox_integrations` (shared check: `core/utils/featureFlags.js`). Its parcel state lives on the shipment (`carrier_response.sandboxStatus`), so it survives restarts and the poller sees it.
- Storefront cache (`storefront/storefrontCache.js`): raw data only (store, product lists and pages, collections), localized after the read; Redis when `REDIS_URL`, else memory; dropped when an audited store-visible change commits and when the merchant restocks or adjusts stock; not on orders (stock shown ≤ 60 s old; checkout checks real stock). The storefront's Next.js pages stay per-request on purpose (shopper IP for rate limits, staff preview, locale cookie — see `lib/serverApiClient.ts`); they read through this cache instead of ISR.
- A single courier booking stays inside the request: a courier create is never retried automatically (a retry after a timeout could book the parcel twice — the adapters say so), and the merchant waits for the waybill. Bulk shipping goes through the queue (item 10).
- Automatic booking (`shipping/carrierBooking.js`) runs on `order.confirmed` / `order.paid` on the carriers queue with the default courier (or the only one set to book on its own), and is never retried for the same reason. A failed one — address not in the courier list, courier refusal — becomes a per-order merchant notification plus an audit row on the order, and the merchant books it by hand. Test orders are booked automatically only by the sandbox courier. An order that already has an active shipment is left alone.
- Places (`geo_regions`, migration 403): two levels, governorate (Egypt's 27 + North Coast, Saudi Arabia's 13 regions) and city (343 in Egypt, 84 in Saudi Arabia). Egyptian governorates keep their existing codes; North Coast is `north-coast`; Saudi regions are `sa-*`; cities are `<parent>.<slug>`. The list changes only by migration. The storefront form still takes the city as free text; the order's text is read back to a place when booking.
- Courier area map (`carrier_region_map`, migration 404): rows matched by name are shared by every store (`workspace_id` null), because a courier's list is the same for everyone, and are refreshed at most daily when a store opens the Areas screen. A store's own choice is stored per store and wins. A pick made on one order's booking is not remembered as the area's mapping: that order's street may not represent the area. Mappings are set only from the Areas screen.
- The sandbox courier now has two levels (city > district, Bosta-shaped) built from `geo_regions`, with North Coast towns under Alexandria and Matrouh, so district picking and mapping can be exercised.
- Bulk shipping with a connected courier (`shipping/bulkShipping.js`, migration 405) is a batch on the carriers queue: preview (ready / missing an area / cannot ship) → batch → one booking at a time, each through `createCarrierShipment` exactly as from the order page, recorded as the person who started it. A booking is never repeated on its own: an item left `booking` by a crashed run becomes booked if its order now has the shipment, else failed "interrupted". Only the merchant sends failed ones again (`/retry`). The old synchronous `POST /orders/bulk` action `ship` stays for manual courier names; the dashboard sends a connected courier through the batch.
- A missing area is fixed in the dialog on the areas map when the order's city is on the platform's list (every order from there follows), else for that order only (`addresses`).
- Orders list columns and saved views stay per device (localStorage), as they were: SPEC says "saved per user"; moving them to the server is a separate change, not needed for any flow. Export selected goes through the export's `ids` filter (≤ 100 ids, a GET URL); resend to webhook uses the existing `POST /webhooks/resend-orders` (≤ 100, webhooks.manage).
- "Notify the customer" on a cancellation or refund is `notifyCustomer` on the event payload: false sends no order email and skips the store's automations for that event (webhooks and everything else still run); true sends the order email even while that template is switched off; unset follows the settings. A gateway refund settled later by webhook follows the settings. A cancellation with `refundAmount` stands when the refund fails (`refundError`).
- "Confirm via WhatsApp" sends the ready-made automation's `order_confirmation` template (it must be approved on Meta under that name); without WhatsApp it is a wa.me link from the merchant's own phone. Editing the customer on an order changes the order's snapshot only, not the customer profile.
- A checkout is captured from a name alone (phone_normalized null, migration 406) or from a valid number for the form's country (an Egyptian mobile on an Egyptian form, 8–15 digits otherwise), 800 ms after typing stops. A save without a number keeps the number the session already has. The server still normalises a non-Egyptian local number with the Egyptian default, as orders do; a store country setting would fix both.
- `checkout.created` is the first autosave of a session; `checkout.updated` follows a new number or other lines at once, and a name/email edit at most once a minute per session (autosaves fire at every pause in typing). The payload carries the contact, the lines, the total and the product ids (for endpoint filters).
- "Save my card" is the shopper's tick at checkout (`saveCard`, kept in the order's completion context); the card is saved after the payment is captured, with the gateway's token only. A funnel offer accepted after an order paid with a card saved that way is a card order charged to it at once (outside the session transaction); declined, it stays unpaid and expires, and the first order is untouched. Without a consented card the offer is cash on delivery, as before.
- A funnel's currency is applied without converting prices: the funnel publishes only when its offers, order bump and page product are priced in its currency, and an order placed on it in another currency is refused (FUNNEL_CURRENCY_MISMATCH). What a shopper is charged is the price the merchant set; FX conversion of charges waits on the rate provider, an open decision (SPEC §11.5).
- The storefront display currency is display only: the header switcher (and the builder `currency_converter` element, which shares the choice) adds an "≈" amount under the price in the chosen currency from the store rates; the cart, checkout and charge stay in the price currency. The choice is remembered per store in the browser; "convert automatically" picks the visitor currency from the browser language region on a first visit when the store lists it.
- Reports add orders up in the store base currency (currencies/baseAmounts.js): the order total is its recorded `total_amount_base`, and its other amounts (refunds, discounts, shipping, lines) are converted by that order own base/total ratio, so the rate is the one of the day it was placed. Applies to attribution, ad campaigns, P&L, the overview, the analytics summary and funnel analytics. Product costs and product economics are entered in the store currency and are not converted. An order placed when no rate was known counts at its own amounts, as before.
- `Lead` fires from the browser on a newsletter sign-up (footer band and popup) and on a funnel opt-in step, with a browser event id the server relay reuses. The builder `form` element is a contact form (`contact_form.submitted`) and sends no Lead. Headless browsers are dropped as bots by the events endpoint, so a browser check needs a desktop user agent.
- Exporting the orders list (the Export button) is built in the `io` queue (`POST /exports/orders`, migration 407 `export_files`); the file goes to private storage and an `export.ready` notification (bell and email, now on by default) links to `/exports/:id`, where the teammate who asked downloads it with their session. Only that teammate sees it; it is kept 7 days, then the sweep removes it (410 after). Exporting ticked orders (at most 100) still downloads at once.
- `integration.failed` (notifications/integrationAlerts.js) is sent for the connection itself only: a gateway that refuses the keys or does not answer (starting a payment, refunds, status checks, saved-card charges), a payment webhook whose signature does not match the stored secret, a courier refusing the stored key or a permission (every call through `withAuthHandling`), WhatsApp refusing the token or not answering. A declined card, an address or an undeliverable number are not. Once a day per integration and reason; it never waits on or fails the call. WhatsApp webhooks with a bad signature send nothing: the URL carries only the public store id, so anyone could trigger it. Still open: a subscription renewal whose gateway refuses the keys is counted against the shopper (subscriptions/subscriptionService failRenewal) — the merchant is now told, but the renewal still fails.
- Orders are attributed by their own touch (analytics/orderTouch.js): the last unless the merchant picks first, the other one when that is missing, the whole touch at once; an order from before touches were kept uses its purchase event. Attribution, the campaigns screen and P&L by campaign all read it, so a campaign has the same orders everywhere. Visitors stay per visit (events): a visitor has no order to carry a touch.
- `analytics_daily` (migration 408) holds the overview's event counts per store day, for the store and per funnel. The overview reads whole days from it and counts the partial days at the window's edges (always today) from raw events, so it stays exact; a row counted before its day ended (+10 min) is recounted on the spot, which also fills old ranges once. `analytics.rollup_days` (every 30 min) counts finished days after each store's midnight. Total visits are now the sum of daily visits (a session past midnight counts on both days). Orders, lost checkouts and the breakdowns (sources, devices…) still query their tables.
- The team screen groups people who joined into Admins (owner and the Admin invite, `workspace_manager`) and Members (every other role); pending invites stay in their own table. The seat counter is the API's (`/team/access-options`: members and pending invites); the old `POST /workspaces/:id/members` invite now has the same seat limit as `/team/invite`.
- The phone verification code and the WhatsApp sign-in code go through the platform's WhatsApp provider (authentication template), SMS when WhatsApp cannot deliver, and — for sign-in — email when there is no verified phone any more, so nobody is locked out. WhatsApp two-step sign-in can only be turned on with a verified phone.
- Account settings (`/workspaces/:id/account-settings`, workspace.manage): the timezone column, `settings.account.contact_form_email` (each `contact_form.submitted` is emailed there by contacts/jobs.js; empty = bell/list only) and `settings.account.legal` (name, company, phone, address, country) printed under the store name on invoices. A new timezone drops the store's analytics_daily rows so they are recounted on the new days. Store contact details (settings.store_info) stay the storefront's.
- Plan limits on leads and storage (billing/limitGuards.js): `leads` = contacts created this calendar month (UTC, as usage_counters) by forms and the newsletter; past it a NEW lead is refused with 402 at the form/newsletter (someone the store knows is never refused) and the merchant gets `plan.limit_reached` once a month. Manual contacts by staff are not limited. `storage_bytes` = media library + digital product files (shoppers' photos are not counted); an upload that would pass it is refused. The usage block shows new leads this month.

## P0 — correctness, compliance, launch gates

- [x] 1. Events that never fire: record `order.unreachable`, `order.postponed`
  (confirmation outcomes), `order.returned` (shipment returned),
  `order.payment_failed` (online payment failed); send the server Purchase of an
  online-paid order on `order.paid`; the digital-delivery email listens for
  `digital.delivered` but the event is `order.digital_delivered`.
- [x] 2. Marketing messages respect opt-out and the blocklist: a STOP reply is
  recorded even for a customer who never opted in (`customers.marketing_opted_out_at`);
  recovery / review-request / lead automations skip opted-out and blocked
  phones; recovery tokens `{{product_name}}`, `{{cart_total}}` work for lost
  checkouts; ready-made recovery text says how to stop.
- [x] 3. Automations on customers, not only orders: `lead.created` (newsletter,
  forms, funnel opt-in) and `subscription.renewal_failed` (the service records
  `subscription.payment_failed`) reach the automations engine.
- [x] 4. Carrier sandbox adapter + README of the carrier contract +
  `POST /dev/sandbox/shipments/:id/advance` (Gate 2 depends on it).
- [x] 5. `requestId` on every log line (request context in the logger).
- [x] 6. Storefront cache: 60 s on `GET /store/:ws` and products, invalidated on
  `product.updated` / `funnel.published`; storefront ISR that actually revalidates.
- [x] 7. Background work in the worker: `ads.sync_spend` and `fx.update_rates` as
  queue schedules, not `setInterval` in every API process; the duplicate upload
  sweep timer removed. (Courier booking: see Decisions.)
- [x] 8. Error reporting (§3.5 Sentry, backend + worker; the dashboards and the storefront are not wired yet): an error-reporter interface, console by
  default, Sentry when `SENTRY_DSN` is set.
- [x] 9. Refresh token in an httpOnly cookie in production (§3.4 #2): already built,
  behind `AUTH_REFRESH_COOKIE=true` — an owner setting, because the cookie only
  works once the dashboard and the API share a site (app.x + api.x). Nothing to
  code; turn it on with the deploy.
- [x] 10. Shipping data (10a shipment_events, 10b per-account booking settings + automatic booking, 10c geo_regions + carrier_region_map, 10d bulk ship batches): `geo_regions` seed (Egypt + North Coast + districts,
  Saudi regions), `carrier_region_map` (stored, editable), `shipment_events`
  timeline, per-carrier-account `autoCreateShipmentOn` / inspection / courier
  notes; bulk ship shows ready vs missing-mapping and retries failures.

## P1 — Phase 1/2 features still missing

- [x] 11. Orders list (11a search by waybill, the filters below, date shortcuts and risk tab counts; 11b columns IP country / data quality / shipping / address, reorderable; 11c bulk invoices, webhook resend, export selected): search by waybill; filters dataQuality, ipCountry,
  discount code, utm source/campaign, funnel, product control, date shortcuts;
  columns IP country / data quality / shipping / address, reorderable; risk tab
  counts; bulk print invoices, resend webhook, export selected.
- [x] 12. Order page (12a whatsapp-confirm, 12b customer card copy/link/block/edit + map link, 12c coupon + bundle card, 12d cancel with refund + notify, refund notify): `POST /orders/:id/whatsapp-confirm` (template with buttons
  when WhatsApp is connected); customer card copy/link/block/edit; map link;
  coupon + bundle discount card; cancel with refund + notify; refund notify.
- [x] 13. Lost orders capture on a name or any valid phone for the store's
  country, 800 ms debounce.
- [x] 14. Webhook topics `checkout.created` / `checkout.updated` (`lead.created` is recorded since item 3).
- [x] 15. Payments (15a shopper consent to save a card + one-click upsell charge; 15b funnel currency applied; 15c display currency switcher + `currency_converter` element; 15d base amounts in attribution/P&L): funnel currency applied to orders, storefront display
  currency switcher, `currency_converter` element, base amounts in
  attribution/P&L; shopper consent to save a card and one-click upsell charge.
- [x] 16. Lead pixel event from the newsletter form.
- [x] 17. Notifications: integration-failed for gateway / carrier / WhatsApp (17a);
  export ready (17b).
- [x] 18. Analytics: `analytics_daily` rollup filled by the worker (18a); attribution
  from `orders.attribution` with first/last touch (18b).
- [x] 19. Team screen admins/members + seat counter (19a); phone verification screen (19b);
  2FA code over WhatsApp (19c); account settings (timezone, contact-form email,
  legal company/country (19d1), owner picture (19d2)); plan limits on leads and storage (19e).
- [ ] 20. Digital delivery link on the thank-you page and by message.
- [ ] 21. AI: apply a generated funnel as funnel steps; AI entry points in the
  product form and the funnel wizard.
- [ ] 22. Shipping profiles + products.shippingProfileId; shipping options the
  shopper chooses between.
- [ ] 23. Merchant PWA web push + `device_tokens`.

## P2

- [ ] 24. Orders pipeline (kanban) page; refresh button; saved views per user.
- [ ] 25. Lost orders product filter and bulk delete.
- [ ] 26. Carriers screen tabs, search, country filter; manifest.
- [ ] 27. Installed apps gate their features; support access enforced for admins.
- [ ] 28. Platform admin: carrier city mapping, theme catalog.
- [ ] 29. Contacts: segments in automations; tags from funnel buttons.
- [ ] 30. Store PWA; ZIMOS referral program screen for merchants.
- [ ] 31. Customer service bot (§19.3) on the sandbox AI provider.
- [ ] 32. Inbox "Create order" opens a pre-filled new order.

## P1 — §7–§10 (catalog, store design, funnels, offers)

- [ ] 33. Cross-sell at checkout and on the thank-you page (the dashboard offers
  both, the store shows only the cart); `add_to_cart` with `source=cross_sell`.
- [ ] 34. Product order bumps on `/checkout` (only the store-wide bump shows).
- [ ] 35. Product list uses the backend filters (collection, sku, type, stock)
  and server search; created date, "Not tracked", preview in store.
- [ ] 36. Product SEO fields in the product form (backend and store read them).
- [ ] 37. Storefront honours `auto_select_variant`, `landing_page_id`; a
  related-products section that `hide_related_products` can hide.
- [ ] 38. Funnel runtime uses the funnel's currency, favicon and title (ties to 15).
- [ ] 39. Custom-field answers on the waybill; `priceDeltaAmount`.
- [ ] 40. Shopper review form with a photo; reviews import (Shopify) on the
  sandbox; public review endpoint must not reveal purchases by phone.
- [ ] 41. Translations of pages and funnels; "Translate with AI"; server-side
  `<html lang dir>` for the store (SEO).
- [ ] 42. Page settings in the builder: SEO and Scripts tabs.
- [ ] 43. Funnel map editor (pan/zoom, link points per button, thumbnails,
  stats); wizard with currency step and template gallery.
- [ ] 44. Missing builder elements (container, popup, image_gallery,
  variant_selector, bundle_selector, review_form, checkout elements…).
- [ ] 45. Funnel analytics: EPC, per-page CTR/CR/opt-ins (events carry stepKey).
- [ ] 46. Product video (mp4) upload.
- [ ] 47. Themes catalog (`themes`, `workspace_themes`) instead of presets.
- [ ] 48. Product-page A/B tests (`subjectType=product_page`).
- [ ] 49. Custom code (§8.4) exercised end to end; head code server-rendered.

§5 (fraud) and §22 Gate 1 (no mock pages, no mockCommerce.ts) are complete.
