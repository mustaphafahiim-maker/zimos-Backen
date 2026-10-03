# Lane 3 — Catalog and offers

## Done
- [x] 1. Product fields + page settings — backend: the "Product page fields" commit / frontend 98bba69 — PATCH/GET over HTTP on the lane DB: fields saved, 41-char button text refused (422), public product carries options/pageSettings/cms and never externalRefs, hidden product absent from plain list, sorted list and search, countdown past → public price and shipping-quote subtotal revert to compare-at. Dashboard and storefront typecheck; not opened in a browser (preview_start refused: 5 dev servers of other chats running).
- [x] 2. Product CMS — same commits — features/testimonials/FAQs saved and returned publicly; storefront shows features + testimonials sections and the product's FAQs in the FAQ tab.
- [x] 3. Variant bulk editor, duplicate, list bulk edit — backend: the "Bulk edit products" commit / frontend bb186f6 — over HTTP on the lane DB: duplicate → draft copy with new slug/code, stock 0, no SKU; variants/bulk set price, SKU and stock (one inventory movement written), a variant of another product refused (422); products/bulk set status + free shipping + −10% price; unknown id refused whole (422 PRODUCT_NOT_FOUND); list filters q / sku / stock. Dashboard typechecks; not opened in a browser (only one preview slot free, the dashboard needs two).
- [x] 4. Reviews — backend: the "Manual reviews" commit / frontend d1c49a4 — over HTTP on the lane DB: manual review created approved (source manual), a pending one stays out of the store, rating 9 refused (422), public product returns average + count + distribution and the review with author, photos, verified:false; shopper with no delivered order gets 403 NO_DELIVERED_PURCHASE; manual delete works. Both apps typecheck; not opened in a browser (preview slots taken).
- [x] 5. Import/export — backend: the "Import and export products" commit / frontend 53d3751 — over HTTP on the lane DB (job run by hand, the script has no worker): export.json returns the catalog; re-importing it in the same store reports the SKU clash per product; a CSV with Arabic, quoted commas and two rows of one name creates one product with two variants, stock, weight and a new collection, and reports the row with a bad price; an .xlsx built in the script (deflate, shared + inline strings) imports; unreadable file / no columns / no input / non-product link / private host all 422; a live Shopify link (allbirds) imported as a draft. Dashboard typechecks; not opened in a browser.

## Next
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
- 2026-10-03 Bulk shipping change offers only standard/free (extra_fee needs an amount per product). Bulk price applies to every active variant: set, +% or −%.
- 2026-10-03 A duplicate copies active variants without SKU or stock (SKU is unique per store), active offers and collection membership; it is always a draft.
- 2026-10-03 Stock typed in the variant table is saved as an inventory adjustment movement, never written directly.
- 2026-10-03 Manual reviews: `reviews.customer_id` nullable + `author_name`, `photos`, `source` (migration 186). Approved by default; only manual ones can be deleted. Shopper reviews show first name + initial.
- 2026-10-03 Shopper review form has no photo upload: customer uploads are private, short-lived files; photos come with manual reviews. Shopify review import is left to item 5's import work.
- 2026-10-03 Import: every source becomes the same "transfer product" list stored on `catalog_imports` (migration 187); the `io` job `catalog.import` (catalog/jobs.js) creates products through catalogService and writes the per-row report. JSON money is minor units; the sheet is major units.
- 2026-10-03 No spreadsheet dependency: `importExport/sheetReader.js` reads CSV and .xlsx (zip + XML) itself; the template is CSV with a BOM (opens in Excel).
- 2026-10-03 Shopify link: https only, public addresses only (webhookUrlGuard lookup), no redirects, 2 MB cap; images stay as the source URLs; SKUs dropped; always a draft. Other link sources (AliExpress, Amazon…) are the spec's open decision — not built. Shopify review import not built.
- 2026-10-03 The api-client's private `rawFetch` is reached by one typed cast in endpoints/catalog.ts for the multipart upload (client.ts may not be edited).

## Blocked

## Handoff
Items 1–5 landed on zimos-additions. Next is item 6 (collections showInHeader, hidden); nothing half-done.
Browser checks still owed for items 1–5 when preview slots are free (other chats hold 4 of the 5; this lane needs backend + one app): dashboard /catalog (checkboxes, Duplicate, bulk bar, Import / export), /catalog/<id>, /reviews (Add review), storefront /products/demo-t-shirt.
Next free migration: 188. API verification pattern: a one-shot node script that does require('./src/app').listen(0) and fetches (delete it after); it has no worker, so call a job's handler directly.
My api-client file: packages/api-client/src/endpoints/catalog.ts. Storefront strings for my pieces live beside the components (components/product/productPageText.ts), not in lib/i18n.ts. New catalog routes go in catalog/catalogBulkRoutes.js or a router it mounts (it sits ahead of /products/:productId).
