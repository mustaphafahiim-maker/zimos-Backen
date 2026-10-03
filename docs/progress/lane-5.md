# Lane 5 — Store design, builder and funnels

## Done
- [x] 1. Checkout form builder (§8.6) + thank-you page settings (§8.7) — checked by driving the real API on `zimos_lane_5` (defaults, PATCH, bad key → 422, required custom field, wrong choice, discount code while switched off, order without city, `checkoutFields` on the order, reset); storefront `tsc --noEmit` and dashboard `tsc -b` clean. The two screens were **not** opened in a browser: `preview_start` refused ("Maximum 5 dev servers per folder", all five held by other lanes).

## Next
- [ ] 2. Store info and policies (§8.3, §8.5): `settings.legal`, policy templates, trust cards; page flags `showInHeader`, `showInFooter`, `isActive`.
- [ ] 3. General settings (§8.8): favicon, social links, floating WhatsApp button; store SEO, `sitemap.xml`, `robots.txt`, product JSON-LD (§8.9).
- [ ] 4. Custom code slots (§8.4) stored outside the page tree, served only on the store domain.
- [ ] 5. Domains (§8.11): dashboard screen, `resolve-host` in `proxy.ts`, `sslStatus` + `certificateProvider` interface with a sandbox adapter, home funnel.
- [ ] 6. Builder elements in batches (§9.3).
- [ ] 7. Style and layout tabs with per-device overrides; global styles; saved sections.
- [ ] 8. Data binding and repeater (§9.4).
- [ ] 9. Funnel wizard, duplicate, share code; step type `article`; map editor (§9.1, §9.2).
- [ ] 10. Split tests (§9.6); geo redirects; funnel settings (§9.7).
- [ ] 11. Translations table and languages screen (§8.10).

## Decisions
- 2026-10-03 All lane-5 settings screens are tabs of one dashboard page, `/store-settings/:tab` (`pages/storeDesign`), sidebar entry "Store settings" in the Storefront group. A new area = one tab file + one entry in `TABS`. Shared pieces: `useSettingsEditor`, `SettingsFormFooter`, `ToggleRow`.
- 2026-10-03 `checkout_settings.fields[]` wins over the old `email` / `postal_code` / `notes` switches once saved; the dashboard writes both so old readers agree. The old "Checkout fields" card was removed from Settings (it would write switches the list overrides).
- 2026-10-03 Besides the spec's keys the list keeps `postal_code` (it already existed). Custom fields are limited to `custom_1…custom_5`, type text or choice.
- 2026-10-03 Answers with no column (`sa_national_address`, `custom_N`) travel as `formFields` in the checkout body, are stored on `orders.checkout_fields` (migration 235) with the label shown, and are appended to the order note so the existing order page shows them without touching lane 1's screen.
- 2026-10-03 `city` and `addressLine` are no longer required by the checkout Joi schema; the per-store form enforces them (required by default).
- 2026-10-03 `country` field: a fixed list of 13 Arab countries; outside Egypt the governorate is free text and the phone is checked loosely (8–15 digits).
- 2026-10-03 `layout: one_step` hides the product page's inline form; "Order now" adds to cart and opens `/checkout`.
- 2026-10-03 `thank_you_page.content` is plain text (one paragraph per line, `{{order_number}}`, `{{customer_name}}`), never HTML.
- 2026-10-03 `auto_select_region` / `auto_select_variant` are stored and exposed; the storefront does not read them yet (item 3).

## Blocked
- Browser verification of dashboard/storefront screens — the preview tool allows 5 dev servers per folder and other lanes hold them. Retry `preview_start lane-5-*` at the start of each turn.

## Handoff
Branch `lane-5` in both worktrees, landed on `zimos-additions` after item 1. Migration range 235–259: 235 used. API client module: `packages/api-client/src/endpoints/storeDesign.ts`. To check an API without a dev server, boot `src/app.js` on port 0 from a one-off node script in the backend worktree (the app is exported from `src/app.js`).
