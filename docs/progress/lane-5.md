# Lane 5 — Store design, builder and funnels

## Done
- [x] 1. Checkout form builder (§8.6) + thank-you page settings (§8.7) — checked by driving the real API on `zimos_lane_5` (defaults, PATCH, bad key → 422, required custom field, wrong choice, discount code while switched off, order without city, `checkoutFields` on the order, reset); storefront `tsc --noEmit` and dashboard `tsc -b` clean. The two screens were **not** opened in a browser: `preview_start` refused ("Maximum 5 dev servers per folder", all five held by other lanes).
- [x] 2. Store info and policies (§8.3, §8.5) + page flags — checked on the real API on `zimos_lane_5`: `store_info` and `legal` saved and read back publicly, `{{store.*}}` variables filled in `GET /store/:ws/policies/:key`, unwritten/unknown policy → 404; a published check site: `showInHeader`/`showInFooter` put the page in `navPages`, `isActive:false` → public page 404 and out of `navPages`, back on → 200, bad flag type → 422. Typechecks clean. Screens not opened in a browser (same preview limit).
- [x] 3. General settings (§8.8) and store SEO (§8.9) — checked on the real API on `zimos_lane_5`: `general`, `social_links`, `floating_whatsapp`, `store_seo` saved and read back publicly; `javascript:` link, bad phone, bad verification code, 3-letter country → 422; WhatsApp button off → `null`; title template without `%s` → ignored; `GET /store/:ws/sitemap` lists home, listing, products, the published active page and the written policy. Typechecks clean. Storefront pieces (favicon/meta, floating button, footer social row, `sitemap.xml`, `robots.txt`, product JSON-LD) and the General/SEO tabs not opened in a browser (same preview limit).
- [x] 4. Custom code slots (§8.4) — checked on the real API on `zimos_lane_5`: all eleven slots listed; no session → 401; save head / UI block / css / js; unknown slot, code over 50,000 characters, missing `isActive` → 422; public read returns only active non-empty slots and nothing at all to a request carrying `X-Store-Preview`; each save writes a `custom_code.update` audit row with the actor and slot. Typechecks clean. The tab and the slot injection in the store were not opened in a browser (same preview limit) — **the injection code in `components/CustomCode.tsx` has never run**; open a store on `<slug>.localhost:3205` first thing when a preview slot is free.

## Next
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
- 2026-10-03 Policies are plain text (one paragraph per line), not rich text: the store never renders merchant markup. Templates (AR/EN) live in the dashboard (`pages/storeDesign/policyTemplates.ts`); variables are filled by the server when a policy is served.
- 2026-10-03 The public store meta carries only *which* legal policies exist (`legal: [keys]`); the text is served by `GET /store/:ws/policies/:key` and shown at `/policies/<key-with-dashes>` (`policies` added to the reserved page segments).
- 2026-10-03 Page flags are live switches on `website_pages` (migration 236), not part of the published snapshot: they apply without a publish. Home (`/`) is never listed in `navPages` and cannot be switched off from the screen.
- 2026-10-03 When `store_info` is on and has cards, the product page shows them in place of the generic trust row.
- 2026-10-03 PATCH bodies strip unknown keys (project convention), so an unknown key inside `legal` is ignored, not refused.
- 2026-10-03 `auto_select_region` is honoured by the checkout page. `auto_select_variant` is stored and exposed but the product page still pre-selects the first available variant: switching that off needs a "choose an option" state in lane 3's `ProductLanding`, left for them.
- 2026-10-03 General settings live in four settings blobs (`general`, `social_links`, `floating_whatsapp`, `store_seo`), no new columns: `faviconUrl` and `country` are in `settings.general`. Favicon and share image are pasted as links (media library link), not uploaded from this screen.
- 2026-10-03 Sitemap: the backend lists the paths (`GET /store/:ws/sitemap`), the storefront renders `sitemap.xml` / `robots.txt` per store; `proxy.ts` rewrites those two files to the store on a store host. Collections are not listed (they have no address of their own). Social links render as lettered round links, not brand logos.
- 2026-10-03 Custom code: table `workspace_custom_code` (migration 237), module `modules/customCode`, reading and writing both need `website.publish`. "Upload design files" is two text slots (`css`, `js`), not file uploads. The store injects code on the client with a contextual fragment (so scripts run after client navigation too), which means head code is not in the server-rendered HTML — domain-ownership meta tags belong in the SEO tab's Google verification field instead.
- 2026-10-03 Custom code runs only when the store is served at the root of its own host (base path empty), never on the shared `/store/<id>` host (one origin for all stores), never on `/pay/…` or `/preview…`, and the API returns no slots to a request with a preview header.
- 2026-10-03 Bot protection, quantity limit and per-phone limit from the §8.8 table belong to lane 2 (`fraud_rules`); announcement bar, colours, fonts and logo already exist in the website editor — not repeated here.

## Blocked
- Browser verification of dashboard/storefront screens — the preview tool allows 5 dev servers per folder and other lanes hold them. Retry `preview_start lane-5-*` at the start of each turn.

## Handoff
Branch `lane-5` in both worktrees, landed on `zimos-additions` after item 4. Migration range 235–259: 235, 236, 237 used. The lane database has a published "Lane 5 check site" (pages `/` and `/about-us`) made for checking page flags. API client module: `packages/api-client/src/endpoints/storeDesign.ts`. To check an API without a dev server, boot `src/app.js` on port 0 from a one-off node script in the backend worktree (the app is exported from `src/app.js`).
