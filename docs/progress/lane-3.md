# Lane 3 — Catalog and offers

## Done
- [x] 1. Product fields + page settings — backend: the "Product page fields" commit / frontend 98bba69 — PATCH/GET over HTTP on the lane DB: fields saved, 41-char button text refused (422), public product carries options/pageSettings/cms and never externalRefs, hidden product absent from plain list, sorted list and search, countdown past → public price and shipping-quote subtotal revert to compare-at. Dashboard and storefront typecheck; not opened in a browser (preview_start refused: 5 dev servers of other chats running).
- [x] 2. Product CMS — same commits — features/testimonials/FAQs saved and returned publicly; storefront shows features + testimonials sections and the product's FAQs in the FAQ tab.

## Next
- [ ] 3. Variant bulk editor, product duplicate, product list bulk edit.
- [ ] 4. Reviews (§7.7): storefront display + form; manual add from the dashboard.
- [ ] 5. Import/export: JSON, xlsx/CSV with error report, Shopify product link.
- [ ] 6. Collections: `showInHeader`, `hidden`.
- [ ] 7. Bundles and tiers (§10.1) priced on the server, storefront tier picker.
- [ ] 8. Order bumps per product, cross-sell, post-purchase upsell rules, exit downsell.
- [ ] 9. Coupons: bulk generate, automatic discounts, `?coupon=`; minimum order, free-shipping bar.
- [ ] 10. Social proof from real orders, newsletter form, referral links.
- [ ] 11. Offers hub page; product feed XML/CSV and Google Merchant checklist.

## Decisions
- 2026-10-03 Items 1 and 2 share migration 185 (`priority`, `special_offer_text`, `external_refs`, `page_settings`, `cms`) and land as one commit per repo.
- 2026-10-03 `page_settings` keeps the spec's snake_case keys; only changed keys are stored, defaults resolved in `catalog/productPage.js` (inline form, sticky button and reviews default on = the page's behaviour before the settings).
- 2026-10-03 `free_shipping` is not a page setting: the existing `shippingMode: 'free'` already does it.
- 2026-10-03 Countdown: `page_settings.countdown.ends_at`. After it passes, `effectiveVariantPrice` sells the variant at its compare-at price (storefront, cart and order pricing use the same function). Fixed-price offers (bundles) are not changed by it.
- 2026-10-03 The theme's `productCountdownHours` (restarts for every visitor) is no longer shown on the product page: SPEC §21 forbids fake counters; only the real countdown shows.
- 2026-10-03 Option display types are stored in `Product.options[]` (`displayType`, `swatches`, `images`); option names/values still come from the variants.
- 2026-10-03 `landing_page_id` is stored and validated as a uuid only; rendering a builder page in place of the product template belongs to lane 5's builder.
- 2026-10-03 Hidden products are left out of listings, search and suggestions; priority sorts first in the `newest` and `position` sorts (the id-cursor listing keeps its order).

## Blocked

## Handoff
Items 1–2 landed on zimos-additions. Next is item 3 (variant bulk editor, duplicate, list bulk edit); nothing half-done.
Browser check of items 1–2 still owed when a preview slot is free: dashboard /catalog/<id> (three new cards at the bottom), storefront /products/demo-t-shirt.
Next free migration: 186. API verification pattern: a one-shot node script that does require('./src/app').listen(0) and fetches (delete it after).
