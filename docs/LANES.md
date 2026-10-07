# ZIMOS — parallel build lanes

Several Claude chats build `docs/SPEC.md` at the same time. Each chat is one
**lane**: its own slice of the spec, its own git worktrees, database, ports and
migration numbers. This file is the contract between them. Where it differs
from `docs/SPEC.md`, **this file wins** — the spec was written before Ziad's
code was merged in, and the project owner changed some rules afterwards.

## 1. The rules

1. **Never stop, never ask.** The project owner does not want questions,
   plans for approval, or "shall I continue?". When something is unclear, pick
   the option closest to the spec, write one line under *Decisions* in your
   progress file, and keep going. When an item is blocked, write why under
   *Blocked* and take the next item. You are done only when every item of your
   lane is ticked.
2. **No test suites, no new test files.** Do not run `npm test` / jest /
   vitest suites and do not write tests (owner's decision, 2026-10-03; this
   overrides SPEC §1 rule 13 and the "tests pass" line of its definition of
   done). Verify by using the feature: call the API on your lane's port, open
   the page on your lane's dashboard/storefront. Typecheck before every commit:
   `npx tsc -b` in `apps/merchant-dashboard` (and `apps/platform-admin` if
   touched), `npx tsc --noEmit` in `apps/storefront`.
3. **Stay in your lane.** Work only in your worktrees
   (`C:/Users/GMP/Downloads/zimos-lanes/lane-N/{backend,frontend}`), your
   database (`zimos_lane_N`), your ports and your migration range. Never touch
   another lane's worktree, the main checkouts, `zimos_dev`, `zimos_dev_merged`
   or any other database.
4. **Build on what exists.** Much of the spec is already built (§3 below).
   Before each item, read the existing code for it and build only the gap.
   Follow the conventions of the code you find (module shape, naming, error
   codes, response shapes). Files that existed before your lane: keep edits to
   them small — a require, a route, a one-line hook into a new function — and
   put the logic in new files. Do not restyle or refactor existing screens.
5. **One feature = one commit per repo**, then land it (§5). Commit messages
   in English, imperative, explaining what the merchant gets; end with
   `Co-Authored-By: Claude <noreply@anthropic.com>` using your real model name.
6. **Scope (SPEC §0 still holds):** an integration with an outside party is an
   adapter interface + a `sandbox` adapter + a README of the contract, nothing
   more. No prices in code. Nothing from SPEC §21, ever (no call centre, no
   cloaking, no fake counters/stock/reviews, no QR WhatsApp). Plans, billing
   and Fawaterak are Ziad's and already built: read limits from his plan
   features, do not rebuild or change billing.
   Owner, 2026-10-06: every Lightfunnels feature except LightSchool is in
   scope too (docs/progress/spec-gaps.md, fourth pass); §21 still holds.
   Owner, 2026-10-07: "متسالنيش علي حاجه شوف لايت فانل شغال ازاي واعمل زيه" —
   don't ask, decide and keep building to Lightfunnels' level. Decisions taken
   under it: migrations 450–499 are used up, so the backend chat's next pass
   uses **500–549**; item 182 (Mailchimp/Klaviyo) stays as built — it only
   syncs contacts who gave marketing consent into the merchant's own lists and
   sends nothing from ZIMOS, so it is not a bulk send (§21 unchanged).
7. **Backend rules** (SPEC §1): routes under `/api/v1/workspaces/:workspaceId`
   go through `authenticate` → `resolveTenant` → `requirePermission`; the
   workspace only ever comes from `req.tenant.workspaceId`; money is integer
   minor units through `core/utils/money.js`; every mutation calls
   `recordAudit`; phones go through `core/utils/phone`; secrets are sealed
   (`core/utils/secretBox.js` + `WorkspaceIntegration` for our modules,
   `core/utils/credentialsCipher.js` for carriers/gateways) and never returned.
   Migrations: only numbers in your range, additive, with a working `down`.
8. **Frontend rules:** every string through `useT({ en, ar })`; logical
   Tailwind classes only (`ms-`, `pe-`, `start-`, `text-end`); every page
   handles loading, empty, error and no-permission; reuse the existing
   components (`PageHeader`, `DataState`, `EmptyState`, `Modal`, `Field`,
   `DataTable`, `Section`, `StatusBadge`, `LoadMore`, `Select`, `Toast`) and
   the tokens already in `index.css` — no new UI library, no new palette. New
   API calls go in **your own** `packages/api-client/src/endpoints/<domain>.ts`
   (functions over the shared client, like `endpoints/funnels.ts` and
   `endpoints/developers.ts`) plus one export line in `index.ts`; do not append
   to `client.ts` or `types.ts` (every lane would collide there). Add the route
   in `App.tsx` and the entry in `lib/navigation.ts`. The storefront talks only
   to `/api/v1/store/:workspaceId` and never computes a price.
9. **Design reference:** `C:/Users/GMP/Downloads/hi-events/frontend` (Hi.Events)
   is the reference for how screens should feel — page layout, tables, empty
   states, forms in drawers/modals, settings pages, onboarding. It is AGPL with
   a mandatory attribution footer: **study it, never copy its code, styles or
   assets**. Brand rules: `C:/Users/GMP/Downloads/ZIMOS_Universal_AI_Prompt.txt`.
10. **Servers:** start them with `preview_start` using your lane's launch
    names (`lane-N-backend`, `lane-N-dashboard`, `lane-N-storefront`,
    `lane-N-admin`), stop them when the feature is verified. The machine is
    shared with the other lanes: never leave servers running while you code.

## 2. The machine

Windows 11. The Bash tool is Git Bash. `git` is not on PATH: use
`"/c/Program Files/Git/bin/git.exe"`. No Python, no `gh`, no Docker, no Redis
— script with `node`. PostgreSQL 16 on `localhost:5432` (credentials in your
backend `.env`); query it with `pg` from your backend's `node_modules`. Login
for every lane database: `demo@zimos.test`, password in
`src/db/seeders/20260101000000-demo-data.js`.

Set up (or repair) your lane with one command, then read its last lines for
your paths and ports:

    node "C:/Users/GMP/Downloads/.claude/lanes/setup-lane.cjs" N

| Lane | API | Dashboard | Storefront | Admin | Database | Migrations |
|---|---|---|---|---|---|---|
| 1 | 4101 | 5201 | 3201 | 5301 | zimos_lane_1 | 135–159 |
| 2 | 4102 | 5202 | 3202 | 5302 | zimos_lane_2 | 160–184 |
| 3 | 4103 | 5203 | 3203 | 5303 | zimos_lane_3 | 185–209 |
| 4 | 4104 | 5204 | 3204 | 5304 | zimos_lane_4 | 210–234 |
| 5 | 4105 | 5205 | 3205 | 5305 | zimos_lane_5 | 235–259 |
| 6 | 4106 | 5206 | 3206 | 5306 | zimos_lane_6 | 260–284 |
| 7 | 4107 | 5207 | 3207 | 5307 | zimos_lane_7 | 285–309 |
| 8 | 4108 | 5208 | 3208 | 5308 | zimos_lane_8 | 310–334 |

## 3. What is already built (read it, extend it, do not rebuild it)

The spec's §2 table and many of its file names describe an older codebase.
The real state on `zimos-additions`:

| Area | Where it lives now |
|---|---|
| Orders: derived **stage** (`orders/orderStage.js`), pipeline counts, search/dates/sort, order page (confirmation panel, shipments, payments, returns, timeline lines), cancel, limited edit, waybill PDF, CSV export (`orders/orderExport*`) | `src/modules/orders`, `pages/orders` |
| Confirmation queue: locks, release, assignment, channels, corrections | `src/modules/cod`, `pages/confirmation` |
| Carriers: adapter contract, Bosta, Mylerz, J&T, address matching, webhooks, polling, manual cancel; governorate rates, weight tiers, shipping quote | `src/modules/shipping`, `pages/shipping` |
| Payments: gateway adapters (Paymob, Kashier), storefront payment flow, two-step refunds, payment sweep | `src/modules/payments`, `pages/payments` |
| Fraud rules (flag/block, duplicates, per-phone limit, rejection threshold), flagged orders, phone blocklist; platform blocklist and cross-store signals | `src/modules/fraud`, `src/modules/risk`, `pages/fraud` |
| Abandoned checkouts: storefront capture, list, recovery status | `src/modules/checkoutSessions`, `pages/abandoned` |
| Catalog: products, variants, offers, collection tree, custom fields and shopper photos, Arabic search/filters/facets, archive/restore; reviews moderation; discounts | `src/modules/catalog`, `reviews`, `discounts`, `customerUploads` |
| Store order bump, funnel bump, upsell joined to the checkout order (offer window) | `checkout/orderBump.js`, `funnels/funnelOfferMerge.js` |
| Website editor (canvas drag/resize, header/footer/announcement, block library, starter sections), six store themes, template gallery (v2 + niche templates) | `src/modules/pages`, `templates`, `pages/website` |
| Funnels: editor, step page editor, storefront runtime `/f`, funnel analytics | `src/modules/funnels`, `pages/funnels`, storefront `app/store/[workspaceId]/f` |
| Analytics: storefront events, web analytics, realtime, summary; profit page (gross profit) | `src/modules/analytics`, `pages/analytics`, `pages/profit` |
| Browser ad pixels (one ID per platform in `settings.tracking_pixels`), server-side CAPI (Meta, TikTok, Snapchat, GA4) on order creation, UTM link builder | `src/modules/marketing`, storefront `lib/adPixels.ts`, `pages/marketing` |
| WhatsApp Cloud API (integration, inbox, webhook), automations (7 order triggers → WhatsApp template, run log), COD settlements | `src/modules/whatsapp`, `automations`, `settlements` and their pages |
| API keys, public orders API (`/api/v1/public`), outbound webhooks (`order.created`, `order.status_changed`), Settings → Developers | `src/modules/apiKeys`, `publicApi`, `webhooks` |
| Plans, limits, draft stores, subscriptions, Fawaterak billing, referral codes and agent commissions, support tickets, platform-admin console | `src/modules/billing`, `platformAdmin`, `referrals`, `support`, `apps/platform-admin` |
| Usernames, sign-up codes, team and roles, merchant audit log and invoices lists, media library | `src/modules/auth`, `users`, `audit`, `invoices`, `media` |

Decisions already taken, so lanes do not diverge:

- **Order status:** Ziad's derived `stage` is the status the merchant sees.
  Do not add a second `status` column. Map the spec's statuses onto stages,
  add the missing ones to `orderStage.js` if needed, put transition guards in
  `orderStateService.js`, and record every change in `order_status_history`.
- **Events:** automations and server pixels fire from
  `transaction.afterCommit` today. Lane 7 introduces the outbox; until its
  `outbox.record` exists on `zimos-additions`, new side work uses the same
  `afterCommit` pattern through one function in your own module.
- **No Redis here:** the queue is an interface with a Postgres-backed driver
  that runs now and a BullMQ driver switched on by `REDIS_URL` (lane 7).
- **Pagination:** follow the module you are in (`{ <plural>, nextCursor }`).

## 4. The lanes

Each list is in priority order. Tick items in your progress file as you land
them. "(exists)" means read the code first and build only what is missing.

### Lane 1 — Orders and fulfilment (SPEC §4, §12.4)
1. `order_status_history` + transition guards (§4.1, per the decision above).
2. Order fields (§4.2): `source`, `tags`, `isSeen`/`seenAt`, `isTest`, `archivedAt`; `order_notes` with internal/public visibility.
3. Order page (§4.4): notes card, tags, full timeline endpoint (`/orders/:id/timeline`), previous/next (`/neighbors`), copy customer link, archive, cancel reasons list, mark seen on open.
4. Orders list (§4.3): tag/source/payment/governorate/courier/seen filters, saved views, column chooser, page size.
5. Bulk actions (`POST /orders/bulk`): set stage where allowed, add/remove tag, archive, print waybills, book courier.
6. Manual order screen (§4.5) on the existing `POST /orders`.
7. Edit order items with price preview before shipping; refund by lines; `POST /orders/:id/fulfill`.
8. `POST /orders/import-tracking` (CSV), bulk waybill PDF (A4 ×4 and 10×15), courier manifest (§12.4).
9. Invoice PDF for an order; xlsx as a second export format.

### Lane 2 — Protection and lost orders (SPEC §5, §6)
1. `blocked_entries` (phone, ip, email, device, name+address; scopes) with list/add/delete/CSV import, linked to the existing customer blacklist.
2. Fraud rule keys of §5.2 with a per-rule action, on top of `modules/fraud` (exists): max items, minutes between COD orders per IP, strict phone validation, allowed countries.
3. `ipIntel` interface + `sandbox` adapter + README; order `ipAddress`, `ipCountry`, `userAgent`; blocked countries and IPs for visitors.
4. Bot protection: honeypot + server-signed time token; Turnstile only as an interface with a sandbox verifier.
5. `riskService.score` → `riskLevel`, `riskScore`, `dataQuality` on the order; risk tabs/badges in the orders list.
6. `customer_network_stats` (hashed phone, platform-wide) + delivery-rate bar + `GET /customers/:id/network-score`, behind a FeatureFlag.
7. Checkout OTP (§5.6) on the existing OTP service, with the code-entry step in the storefront.
8. Fraud page: per-rule actions, "block and cancel", blocked tab with types, statistics tab.
9. Lost orders (§6): `lostReason`, `reviewStatus`, recovery token and `/r/:token` in the storefront, convert to order, delete, export, `abandoned_after_minutes`; emit `checkout.abandoned` for automations.

### Lane 3 — Catalog and offers (SPEC §7, §10)
1. Product fields (§7.1): `priority`, `specialOfferText`, `externalRefs`, option `displayType`; `pageSettings` (§7.3) honoured by the storefront product page (inline COD form, sticky buy button, hidden, real countdown).
2. Product CMS (§7.4): features, testimonials, FAQs.
3. Variant bulk editor, product duplicate, product list bulk edit.
4. Reviews (§7.7): show approved reviews and the review form in the storefront; manual add from the dashboard.
5. Import/export: JSON export and import, xlsx/CSV import with an error report, Shopify product link import.
6. Collections: `showInHeader`, `hidden`.
7. Bundles and tiers (§10.1) priced on the server, with the storefront tier picker.
8. Order bumps per product (up to 3), cross-sell rules, post-purchase upsell rules, exit downsell (§10.2–10.4) — extend the existing bump/upsell code.
9. Coupons (§10.5): bulk generate, automatic discounts, `?coupon=`; minimum order amount and free-shipping progress bar (§10.6).
10. Social proof from real orders (§10.7), newsletter form (§10.9), referral links (§10.8).
11. Offers hub page (§10.11); product feed XML/CSV per channel and the Google Merchant checklist (§7.8).

### Lane 4 — Marketing, messaging and notifications (SPEC §13, §14)
1. Merchant notifications (§14.6): table, bell drawer, read-all, new-order sound, per-user preferences.
2. `tracking_pixels` table (§13.1): several pixels per platform, scope per funnel/product, CAPI token and test code per pixel; migrate `settings.tracking_pixels`; Marketing page as "Tracking tools" with add-pixel dialog, GTM/GA4/Clarity ID fields.
3. Events (§13.2): `add_payment_info`, `lead`, shared `event_id` browser↔server for every event; pixel event log + "send test event".
4. Purchase timing setting (§13.3); order `attribution` and `sessionStats` from a first/last-touch cookie (§13.4).
5. Automations (§14.2): ordered steps (wait, WhatsApp template, SMS, email, webhook, add tag, set stage, notify team), new triggers, conditions and variables, delayed-step runner, ready-made Arabic templates.
6. WhatsApp quick-reply confirmation: the customer's button reply confirms or cancels the order and closes the confirmation task.
7. Inbox (§14.3): customer side panel with orders and actions, quick replies, assignment, filters, live updates (SSE).
8. Order emails (§14.5) on the existing email provider: templates, preview, test send.
9. ~~WhatsApp campaigns (§14.4)~~ — removed by the owner on 2026-10-03 with every other broadcast campaign (SPEC §21). Do not rebuild.
10. Customer tracking page polish (§14.7): stages, courier, public notes.

### Lane 5 — Store design, builder and funnels (SPEC §8, §9)
1. Checkout form builder (§8.6) extending the existing `checkout_settings`; thank-you page settings (§8.7).
2. Store info and policies (§8.3, §8.5): `settings.legal`, policy templates, trust cards; page flags `showInHeader`, `showInFooter`, `isActive`.
3. General settings (§8.8): favicon, social links, floating WhatsApp button; store SEO, `sitemap.xml`, `robots.txt`, product JSON-LD (§8.9).
4. Custom code slots (§8.4) stored outside the page tree, served only on the store domain.
5. Domains (§8.11): dashboard screen, `resolve-host` in `proxy.ts`, `sslStatus` + `certificateProvider` interface with a sandbox adapter, home funnel.
6. Builder elements in batches (§9.3): list, tabs, toggle, carousel, form inputs, price, variant selector, reviews list, COD form, checkout summary, order summary, upsell accept/decline — backend `pageTree` spec + storefront renderer + inspector.
7. Style and layout tabs with per-device overrides; global styles; saved sections.
8. Data binding and repeater (§9.4).
9. Funnel wizard, duplicate, share code; step type `article`; map editor: node stats, links from page elements, issues counter, server-side draft (§9.1, §9.2).
10. Split tests (§9.6) on the existing `Experiment` models; geo redirects; funnel settings (§9.7).
11. Translations table and languages screen (§8.10).

### Lane 6 — Analytics, profit, payments and currencies (SPEC §15, §11)
1. Dashboard home KPIs of §15.1 with period comparison, conversion funnel, top sources/governorates/products, confirmation and delivery rates; `GET /analytics/overview`.
2. Sales attribution report (§15.3).
3. Real profit (§15.4): `product_economics`, `ad_spend_daily` with manual entry and CSV import, P&L endpoint and page (actual/projected, by day/product/campaign, max CPA), campaigns screen; `ads.sync_spend` on a sandbox adapter.
4. Settlements (§15.5): import a courier statement, match waybills, show discrepancies and money still held by couriers.
5. Payments: README of the gateway adapter contract + a `sandbox` gateway; manual transfer with receipt image and merchant confirm/reject (§11.3); deposits.
6. Payment rules (§11.4): fee/discount per method, gateways per funnel, failed-payment retry link.
7. Currencies (§11.5): `fx_rates`, sandbox rates adapter, display currencies, `fxRateToBase` on orders, currency switch in analytics.
8. Saved payment methods interface on the sandbox gateway (§11.6).
9. Realtime view updates over SSE (§15.2).

### Lane 7 — Platform core: infrastructure, API, team, account (SPEC §3, §16, §17)
1. Outbox: `domain_events`, `outbox.record(tx, type, payload)`, queue interface (Postgres driver now, BullMQ when `REDIS_URL` is set), `src/worker.js`, repeatable jobs; move the automation and pixel emits onto it.
2. Security fixes of §3.4 that still apply to the merged code (check each against the code first).
3. Public API (§16.2): products, categories, customers, discounts, shipping areas, order create/notes/tracking, the full scope list, rate-limit headers, public OpenAPI file.
4. Webhooks (§16.1): the remaining topics, per-endpoint filter, auto-disable after 3 days of failures, "resend to webhook" for an order.
5. App install link (§16.3); apps catalogue and `AppsPage` (§16.6); `DropshipProvider` interface + sandbox adapter + README.
6. Team (§17.1): simple invite dialog with section checkboxes, `fulfillment` role; sessions screen with end-one/end-all; two-factor on login; activity log screen; support access grant (§17.2).
7. `requirePlanLimit(key)` on Ziad's plan features and `usage_counters` (§17.4, the allowed part only).
8. Platform-admin screens that are still missing (§17.5); queue status screen.
9. GitHub Actions workflow files for typecheck and build (§3.5).

### Lane 8 — Growth: contacts, stores, digital, AI, affiliates (SPEC §18, §19, §20)
1. Contacts and segments (§18.4): lead/customer type, tags, dynamic segments, form submissions screen.
2. All-my-stores overview and store switcher, duplicate store (§18.5).
3. Global search ⌘K, setup guide on real data, sidebar shortcuts (§18.6).
4. Digital products (§18.2): deliveries, licence codes, signed download links, file library.
5. AI module (§19): provider interface + sandbox provider, usage counter, product generation, funnel/page generation, translation, store policies — output always a draft.
6. Affiliates (§20.3): affiliates, commissions on delivered orders, a simple OTP portal.
7. Dashboard as a PWA (manifest, install prompt) (§20.1 first step).
8. Subscriptions and installments on the sandbox gateway (§18.1); courses (§18.3); shoppable images (§7.9); services marketplace (§20.5).

## 5. Landing your work (after every feature)

In **each** repo you changed, from your lane worktree:

    git add -A && git commit            # one feature, one commit
    git fetch origin
    git merge origin/zimos-additions    # resolve conflicts, keep both sides
    <re-run the typecheck; run db:migrate if migrations arrived>
    git push origin HEAD:zimos-additions

If the push is rejected, fetch, merge and push again. Never force-push, never
rebase published commits, never push to `main`. Conflicts are expected only in
the registry files every lane adds a line to — `src/app.js`,
`core/security/permissions.js`, `packages/api-client/src/index.ts`, `App.tsx`,
`lib/navigation.ts` — and the answer there is always to keep both lines.

## 6. Your progress file

`docs/progress/lane-N.md` in the backend repo, committed with each feature.
Only your lane writes it.

    # Lane N — <name>
    ## Done
    - [x] 1. <item> — <backend commit> / <frontend commit> — how it was checked
    ## Next
    - [ ] 2. <item>
    ## Decisions
    - <date> <what you chose and why, one line>
    ## Blocked
    - <item> — <what is missing>
    ## Handoff
    <what the next chat must know to resume: branch state, half-done work>

Write the *Handoff* section whenever your context is getting long, so a fresh
chat started with the same prompt continues from where you stopped.
