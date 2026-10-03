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
- [ ] 10. Shipping data: `geo_regions` seed (Egypt + North Coast + districts,
  Saudi regions), `carrier_region_map` (stored, editable), `shipment_events`
  timeline, per-carrier-account `autoCreateShipmentOn` / inspection / courier
  notes; bulk ship shows ready vs missing-mapping and retries failures.

## P1 — Phase 1/2 features still missing

- [ ] 11. Orders list: search by waybill; filters dataQuality, ipCountry,
  discount code, utm source/campaign, funnel, product control, date shortcuts;
  columns IP country / data quality / shipping / address, reorderable; risk tab
  counts; bulk print invoices, resend webhook, export selected.
- [ ] 12. Order page: `POST /orders/:id/whatsapp-confirm` (template with buttons
  when WhatsApp is connected); customer card copy/link/block/edit; map link;
  coupon + bundle discount card; cancel with refund + notify; refund notify.
- [ ] 13. Lost orders capture on a name or any valid phone for the store's
  country, 800 ms debounce.
- [ ] 14. Webhook topics `checkout.created` / `checkout.updated` (`lead.created` is recorded since item 3).
- [ ] 15. Payments: funnel currency applied to orders, storefront display
  currency switcher, `currency_converter` element, base amounts in
  attribution/P&L; shopper consent to save a card and one-click upsell charge.
- [ ] 16. Lead pixel event from the newsletter form.
- [ ] 17. Notifications: integration-failed for gateway / carrier / WhatsApp;
  export ready.
- [ ] 18. Analytics: `analytics_daily` rollup filled by the worker; attribution
  from `orders.attribution` with first/last touch.
- [ ] 19. Team screen admins/members + seat counter; phone verification screen;
  2FA code over WhatsApp; account settings (timezone, contact-form email,
  legal company/country, owner picture); plan limits on leads and storage.
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
