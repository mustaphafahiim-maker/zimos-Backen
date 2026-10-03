# ZIMOS — Complete Detailed Specification

> **Read `docs/LANES.md` first.** This specification was written before the merge with upstream: file names, the migration number (now 134) and the "current state" table in section 2 are out of date, and some working rules were changed by the project owner. `docs/LANES.md` has the current state, the rules, and who builds what; where the two differ, `docs/LANES.md` wins.

Oct 2, 2026 · Mostafa Fahiim

This document consolidates every feature of EasyOrders and Lightfunnels into a single specification for ZIMOS, so that the implementing agent can build from it without guessing. The call center is excluded entirely.

## 0. Scope of Work (read this first)

The implementing agent is responsible for **feature code only**. Pricing has not been decided yet, and any integration with an external party is another team's responsibility. If any item in the rest of the document conflicts with this table, this table prevails.

| Item | In scope? | Handling |
| --- | --- | --- |
| Feature code: backend, dashboard, storefront, platform admin panel, infrastructure | Yes | All sections except the ones below |
| Pricing: plans, wallet, order fees, ZIMOS billing gateway, theme and app prices | No, not decided yet | Do not build a wallet or fees, and do not put any price in the code. Any limit or paid feature is read from `Plan.features` or `FeatureFlag` (17.4) |
| Integrations with external parties: payment gateways, shipping carriers, Meta (WhatsApp and ads), TikTok, Snap, Google, SMS, merchant email, Google Sheets, Shopify, WooCommerce, Taager and dropshipping platforms, AliExpress, Mailchimp, Clarity, AI provider, domain SSL, currency exchange rates, IP reputation | No, the integrations team | The agent builds the **unified interface** (adapter interface) + its tables + the settings screen + **a `sandbox` test adapter**. The real adapter for each party is written by the integrations team |
| Integrations already in the code: Bosta, Paymob, WhatsApp Cloud API, server-side Meta/TikTok/Snap/GA4, Twilio, Brevo, R2 | Use only | Features use them as they are. You may move them behind the unified interface without changing their logic, but you must not change how they communicate with the external party |
| Legal decisions (terms, delivery network data) | No | The code is built, and activation stays behind a FeatureFlag until approval |
| The call center | No | Section 21 |

**The `sandbox` test adapter** (for each integration type: payment, shipping, messaging, pixel, dropshipping, AI, currency exchange rates):

- Returns fixed, realistic results without any network connection, so the feature can be exercised end to end and the tests pass. Shipping example: waybill `SBX-000123` + a development endpoint `POST /dev/sandbox/shipments/:id/advance` that advances the status by one step.
- Available only when `NODE_ENV` is not production, or when the FeatureFlag `sandbox_integrations` is enabled for the store.
- In the screens it appears as "Test", and next to it the remaining parties are shown with the status "Coming soon" until the integrations team adds them.
- The unified interface must be documented in a README file inside its folder (methods, input and output shapes, errors), because this is the contract the integrations team will work against.

Every section that involves an external integration starts with a **Scope boundary** line stating what is part of your work and what is not.

## 1. Working Rules for the Implementing Agent

This document is the single source of truth. Anything not written here must be raised with the project owner before you build it; do not invent an endpoint or a table on your own.

**Repositories**

| Repository | Contents | Notes |
| --- | --- | --- |
| `mustaphafahiim-maker/zimos-Backen` | Express 5 + PostgreSQL + Sequelize 6, modules in `src/modules/<domain>/` | The last migration is number `088`; any new migration starts from `089` |
| `mustaphafahiim-maker/zimos-front` | npm workspaces: `apps/merchant-dashboard` (React 19 + Vite), `apps/platform-admin`, `apps/storefront` (Next.js 16), `apps/marketing`, `packages/api-client`, `packages/ui` | About 30 pages in the dashboard are still on `src/mock/` |

**Document terminology**

- **[EO]** = feature that exists in EasyOrders. **[LF]** = exists in Lightfunnels. **[Z+]** = feature beyond both.
- **P0** = required before launch. **P1** = needed to match the competitors. **P2** = after launch.
- **Workspace** = the merchant's store. Every merchant-owned table has `workspace_id`.
- Code statuses: **Working** (backend + UI), **Backend only**, **Mock** (UI on mock), **Missing**.

**Backend rules (mandatory)**

1. Every new module has the same shape: `xRoutes.js` + `xController.js` + `xService.js` + `xValidation.js` (Joi). All logic lives in the Service.
2. Every route under `/api/v1/workspaces/:workspaceId/...` passes through `authenticate`, then `resolveTenant`, then `requirePermission(P)`. Never read `workspaceId` from the body; use `req.tenant.workspaceId` only.
3. Every query on a merchant-owned table is made with `scoped(Model, workspaceId)` from `src/core/utils/scopedRepository.js`.
4. Money is stored as integers in the smallest unit (piasters) in `BIGINT`, and all arithmetic goes through `src/core/utils/money.js`. No floats. In the API, money is returned as a string. Percentages are in basis points (100 = 1%).
5. Pagination uses the shape `{ items, nextCursor }`.
6. Every data modification is recorded in the audit log (the `audit` module).
7. Any secret (API key, token) is stored in `WorkspaceIntegration.secretsSealed`, encrypted with `INTEGRATIONS_ENCRYPTION_KEY`, and is never returned in any response.
8. Phone numbers are normalized with the existing phone normalization util before saving or comparing.
9. Event names use dots: `order.created`, `order.shipped`... and no underscore.
10. Any work after the response (messages, pixels, webhooks, shipping) is put in the queue (section 3), not `afterCommit` fire-and-forget.
11. Every feature is gated by a permission from `core/security/permissions.js`. If you need a new permission, add it there and in the system roles.
12. Any paid or experimental feature is gated by `FeatureFlag` or by `Plan.features`.
13. Integration tests in `tests/integration/` against a real PostgreSQL; for every new endpoint: success, missing permission, tenant isolation, validation.

**Frontend rules (mandatory)**

1. Types are moved from `src/mock/types*.ts` to `packages/api-client/src/types.ts`, and methods are added in `packages/api-client`.
2. When you connect a page to the backend, remove all `mockApi` usage from it. No page may be half real and half mock.
3. Strings use `useT({ en: {...}, ar: {...} })`, and Tailwind uses logical classes (`ms-`, `pe-`, `start-`, `text-end`), with no `left` or `right`.
4. Every page has 5 states: loading, empty, error, no permission, and the normal state.
5. Colors and fonts come from `packages/ui/src/brand/zimos.css` only.
6. The storefront talks only to the public API under `/api/v1/store/:workspaceId`, and there is no pricing logic in the frontend; the final price is computed by the server.

**Definition of "done" for any feature**

- [ ] migration + model + validation + service + routes + permissions
- [ ] integration tests pass
- [ ] methods in `api-client` + types
- [ ] the dashboard page works on real data, in Arabic and English
- [ ] if the feature is customer-facing: it works in the storefront on mobile
- [ ] the event is sent to the queue if there is side work
- [ ] the feature's row in the section 2 table is updated to "Working"

**When to stop and ask:** if there is a conflict between the document and the code, if the feature needs an external account or key (Meta, a shipping carrier, a payment gateway), or if "open decision" is written next to the item.

## 2. Current State of ZIMOS

The backend contains far more than what is visible in the UI: 70 models, 88 migrations, about 451 tests. The biggest problem is that `packages/api-client` has no methods for half of the features, so the pages are still on the mock. This table is the starting point for any task, and it must be updated with every feature that is completed.

| Area | Status | Evidence in the code | What is missing, in brief |
| --- | --- | --- | --- |
| Login (email + Google) | Working | `auth/authRoutes.js`, `AuthContext.tsx` | Nothing |
| Phone verification via OTP | Backend only | `otp/otpService.js` (Twilio) | UI, and WhatsApp channel |
| Team and permissions | Working | `permissions.js`, `SettingsPage.tsx` TeamSection | Custom roles screen |
| Multiple stores | Partially working | workspace = store; `StoresPage.tsx` on mock | `GET /me/stores/overview` |
| Page builder | Working (basic) | `WebsiteEditorPage.tsx` + `blocks.ts` (23 elements) | Live preview, mobile controls, styles (section 9) |
| Funnel builder | Flow map working | `FunnelEditorPage.tsx`, `funnels/funnelsService.js` | Editing step content, rendering the funnel in the storefront, real upsell |
| Templates | Working | `templates` module + 2 seeders | Template type (store/funnel), more templates |
| Storefront | Partially working | `apps/storefront/src/app/store/[workspaceId]` | Bundles, bump, upsell, tracking, and shipping estimate are all in `mockCommerce.ts` |
| Custom domains | Working in the backend | `domains/` + `hostResolver.js` | `proxy.ts` in the storefront only accepts `*.zimos.co`, SSL is manual |
| Checkout settings | Backend only | `settings.checkout_settings` | `CheckoutSettingsTab.tsx` on mock, and fewer fields than [EO] |
| Products, variants and categories | Working | `catalog/`, `pages/catalog/*` | Missing fields (section 7) |
| Inventory | Working | `inventory/inventoryService.js` (row lock) | Nothing substantial |
| Orders | Working | `orders/`, `OrdersListPage.tsx` | Export, bulk actions, state machine (section 4) |
| Confirmation (confirmation queue) | Working | `cod/confirmationService.js` | Out of scope (call center) |
| Automatic order messages | Backend only | `automations/automationEngine.js` (WhatsApp template) | UI is mock, no SMS/email, no queue |
| WhatsApp inbox | Backend only | `whatsapp/whatsappRoutes.js` (Cloud API) | `InboxPage.tsx` on mock |
| Fake order protection | Backend only | `orders/fraudRules.js`, `fraudRoutes.js` | IP, country, bots, OTP, customer score, UI (section 5) |
| Lost orders | Backend only | `checkout/checkoutSessionService.js` | The storefront does not send sessions, no automatic recovery |
| Shipping carriers | Bosta backend only | `shipping/carriers/bostaCarrier.js` | The other carriers, UI (section 12) |
| Waybill PDF | Working | `waybill/waybillService.js` | Bulk printing |
| Returns | Working | `returns/`, `ReturnsPage.tsx` | The refunded status is not used |
| Reviews | Working in the dashboard | `reviews/` | Not shown in the storefront, no manual add or import |
| Coupons | Working | `discounts/` | Automatic discount without a code |
| Quantity offers | Working in the dashboard | `Offer`/`OfferVariant`, `OffersSection.tsx` | The storefront calculates them with mock |
| Bundles, bump and cross-sell | Mock | `OffersPage.tsx`, `mockCommerce.ts` | All of it (section 10) |
| A/B testing | Mock | `Experiment` model without routes | All of it (section 9) |
| Pixels | Server only | `marketing/pixelProviders/*` (Purchase only) | Browser pixel, the remaining events, UI (section 13) |
| Analytics | Backend only | `analytics/analyticsRoutes.js` | The storefront does not send events, UI is mock |
| Ad spend | Mock | `AdsPage.tsx` | All of it (section 15) |
| Profit P&L | Mock | `ProfitPage.tsx` | All of it (section 15) |
| COD settlements | Backend only | `settlements/settlementService.js` | UI is mock with different statuses |
| Affiliates | Mock | `AffiliatesPage.tsx` | All of it (section 20) |
| Apps and integrations | Mock | `AppsPage.tsx`; `WebhookEndpoint` without routes | All of it (section 16) |
| Online payments | Paymob backend only | `payments/providers/paymobProvider.js` | The other gateways, storefront, UI (section 11) |
| Multi-currency | Mock | Single currency `defaultCurrency` | All of it (section 11) |
| ZIMOS's own subscriptions | scaffold | `billing/billingService.js` | Real payment gateway (section 17) |
| Platform admin panel | Backend, UI on mock | `platformAdmin/*Routes.js`, `adminApi.ts` | Connecting the UI |
| Merchant notifications | Mock | `NotificationsDrawer.tsx` | All of it (section 14) |
| Order export | Missing | — | All of it (section 4) |
| Public API and keys | scaffold | `ApiKey` model without routes | All of it (section 16) |
| Product import | Mock | `SuppliersPage.tsx` | Excel/JSON + link (section 7) |
| Email marketing | Missing | — | All of it (section 18) |
| AI | Missing | — | All of it (section 19) |
| Mobile app | Missing | — | Section 20 |

**Notes you must know before any work:**

- The `// BACKEND` comments in `mock/api.ts` and `api2.ts` are outdated for: automations, whatsapp, settlements, abandoned checkouts, fraud, and track/quote in the storefront. These routes now exist under different paths; refer to the actual route, not to the comment.
- Funnel step types differ: the frontend has `order_bump` and the backend has `sales`, `opt_in`, `custom`. The backend is the reference, and the bump is not a step (section 9).
- The backend has 6 page elements that do not exist in the frontend: `shader_hero`, `product_3d`, `orbit_gallery`, `scroll_story`, `marquee`, `comparison`.
- `orderStateService.js` has no transition guards at all; any status can move to any other status (section 4 fixes this).

## 3. Infrastructure That Must Be Built First (P0)

No feature in the rest of the document will work correctly without this section: messages, pixels, shipping and webhooks all need reliable background processing with retries.

### 3.1 Queue + Worker

- Use **BullMQ + Redis**. Add a service named `redis` and a service named `worker` in `docker-compose.yml`.
- A new entrypoint `src/worker.js` runs all the processors. The API never runs heavy jobs.
- The queues:

| Queue | What it does | Retries |
| --- | --- | --- |
| `events` | Dispatches every domain event to its consumers (automations, pixels, webhooks, sheets, network score) | 5 times, exponential |
| `notifications` | WhatsApp, SMS, email, push | 5 times; a permanent 4xx error is not retried |
| `pixels` | CAPI for Meta/TikTok/Snap/Pinterest/GA4 | 3 times |
| `webhooks` | Delivering webhooks to the merchant (section 16) | 1m, 5m, 30m, 2h, 6h, 24h, then `exhausted` |
| `carriers` | Create shipment, cancel, status sync | 5 times |
| `io` | Excel/CSV/JSON import and export, images | Once + error report |
| `ai` | AI requests (section 19) | 2 |

### 3.2 Event Outbox

- New table `domain_events`: `id`, `workspace_id`, `type`, `aggregate_type`, `aggregate_id`, `payload` (jsonb), `occurred_at`, `dispatched_at`, `attempts`.
- The event is written inside **the same transaction** as the change. A dispatcher in the worker pulls the rows where `dispatched_at IS NULL` every second and puts them in `events`.
- Replace every `transaction.afterCommit(() => automationEngine.emit(...))` and `pixelEvents.emit(...)` with `outbox.record(tx, type, payload)`.
- **Event catalog** (the reference for all sections): `order.created`, `order.updated`, `order.status_changed`, `order.confirmed`, `order.rejected`, `order.unreachable`, `order.postponed`, `order.cancelled`, `order.uncancelled`, `order.paid`, `order.payment_failed`, `order.refunded`, `order.shipped`, `order.out_for_delivery`, `order.delivered`, `order.returned`, `order.item_added`, `shipment.status_changed`, `checkout.started`, `checkout.updated`, `checkout.abandoned`, `checkout.recovered`, `lost_order.created`, `customer.created`, `customer.updated`, `lead.created`, `contact_form.submitted`, `product.created`, `product.updated`, `product.deleted`, `product.low_stock`, `review.created`, `funnel.published`, `subscription.created`, `subscription.renewed`, `subscription.cancelled`, `app.uninstalled`.

### 3.3 Cron (inside the worker, using BullMQ repeatable jobs)

| Job | Frequency | Function |
| --- | --- | --- |
| `checkout.detect_abandoned` | Every 5 minutes | Moves sessions that have had no activity for 15 minutes to `abandoned` and emits `checkout.abandoned` |
| `carriers.poll_status` | Every 30 minutes | For shipping carriers that have no webhook |
| `billing.expire_trials` | Hourly | Replaces the manual `POST /billing/run-trial-check` |
| `ads.sync_spend` | Hourly | Pulls ad spend (section 15) |
| `fx.update_rates` | Daily | Currency exchange rates (section 11) |
| `webhooks.retry` | Every minute | Retries the ones whose `nextAttemptAt` has passed |
| `feeds.rebuild` | Every 6 hours | Builds Product Feeds (section 7) |
| `subscriptions.renew` | Hourly | Subscription renewals (section 18) |
| `automations.delayed` | Every minute | Delayed automation steps |

### 3.4 Security Fixes Required Before Launch

1. `src/config/env.js` lines 54-55: `required('JWT_ACCESS_SECRET', 'dev_only_...')` lets the server run with a known secret. In `NODE_ENV=production` it must refuse to start if any of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY` is not set or is shorter than 32 characters. The same applies to the default values in `docker-compose.yml`.
2. The tokens in `packages/api-client/src/tokenStorage.ts` are stored in localStorage. The refresh token moves to a cookie `httpOnly; Secure; SameSite=Lax` on `/api/v1/auth`, and the access token stays in memory only. The Google OAuth callback must stop putting the tokens in the URL.
3. `core/middleware/rateLimiters.js` uses a Redis-backed store (`rate-limit-redis`) so that it works across more than one instance.
4. `STORAGE_PROVIDER=r2` is mandatory in production; the server refuses to start with `local`.
5. `settlementService.listUnsettled` builds a `NOT IN` with all settled orders; change it to a `NOT EXISTS` subquery.
6. The Bosta webhook is secured only by a shared header; add re-fetching of the status from the Bosta API after every webhook instead of trusting the payload.
7. Storefront (Next): security headers (CSP with exceptions for the pixels), and any HTML from the merchant (UI Blocks, custom code) is rendered using the method in section 8.4.
8. Customer phone numbers in lists are partially masked (`010****665`) for any role that does not have `customers.reveal_sensitive`.

### 3.5 Monitoring and Quality

- JSON logger (pino) + `requestId` on every line, and Sentry for the backend, the frontend and the worker.
- A screen in platform-admin for queue status (number of pending and failed jobs) using Bull Board behind `requirePlatformAdmin`.
- **CI on GitHub Actions**: backend (Postgres service + migrate + `npm test`), frontend (typecheck + build for the 4 apps). Add Vitest for pure logic and one Playwright smoke test on the checkout (product → COD form → thank-you page).
- Redis cache (60 seconds) on `GET /store/:workspaceId` and the products, ISR in Next, and cache invalidation on `product.updated` and `funnel.published`.

## 4. Order Management

Goal: an orders screen as strong as EasyOrders in operations (statuses, bulk actions, shipping from the list), and as strong as Lightfunnels in editing, refunds, and order source.

### 4.1 Statuses (the decision)

ZIMOS has 3 status columns: `confirmationState`, `financialState`, `fulfillmentState`. We keep them as they are, and add a fourth column **`status`**, which is the status the merchant sees and filters by. `orderStateService.js` is the only place that changes any status; it updates all 4 columns together and rejects any transition not in the table with error `409 INVALID_STATUS_TRANSITION`.

| `status` | UI label | Source | The three columns |
| --- | --- | --- | --- |
| `pending_review` | Under review | [EO] `pending` | confirmation=pending |
| `unreachable` | No answer | [Z+] | confirmation=unreachable |
| `postponed` | Postponed | [Z+] | confirmation=postponed |
| `confirmed` | Confirmed | [EO] `confirmed` | confirmation=confirmed |
| `awaiting_payment` | Awaiting payment | [EO] `pending_payment` | financial=pending, online payment |
| `paid` | Paid | [EO] `paid` | financial=paid |
| `payment_failed` | Payment failed | [EO] `paid_failed` | financial=failed |
| `processing` | Being prepared for shipping | [EO] `processing` | fulfillment=unfulfilled, ready to ship |
| `awaiting_pickup` | Awaiting shipping | [EO] `waiting_for_pickup` | shipment=created |
| `in_delivery` | Out for delivery | [EO] `in_delivery` | shipment in transit |
| `delivered` | Delivered | [EO] `delivered` | fulfillment=fulfilled |
| `cancelled` | Order cancelled | [EO] `canceled` | `cancelledAt` is set |
| `returned_to_sender` | Returned from shipping | [EO] `returning_from_delivery` | shipment=returned before delivery (RTO) |
| `return_requested` | Customer requested a return | [EO] `request_refund` | ReturnRequest=requested |
| `return_in_progress` | Return in progress | [EO] `refund_in_progress` | ReturnRequest=approved |
| `returned` | Returned | [EO] `refunded` | ReturnRequest=received/refunded |

**Allowed transitions** (anything else is rejected):

- `pending_review` → `confirmed`, `unreachable`, `postponed`, `cancelled`, `awaiting_payment`.
- `unreachable` or `postponed` → `pending_review`, `confirmed`, `cancelled`.
- `confirmed` → `processing`, `awaiting_pickup`, `cancelled`.
- `awaiting_payment` → `paid`, `payment_failed`, `cancelled`. And `payment_failed` → `awaiting_payment` (retry) or `cancelled`.
- `paid` → `processing`, `awaiting_pickup`. `processing` → `awaiting_pickup`, `cancelled`.
- `awaiting_pickup` → `in_delivery`, `cancelled` (the shipment must be cancelled with the shipping company first).
- `in_delivery` → `delivered`, `returned_to_sender`.
- `delivered` → `return_requested`. `return_requested` → `return_in_progress` or back to `delivered` (request rejected). `return_in_progress` → `returned`.
- `cancelled` → `pending_review` only (un-cancel, [LF] `order/uncancelled`), and only if the stock is available again.

Every transition is recorded in a new table `order_status_history` (`order_id`, `from_status`, `to_status`, `actor_type` user|system|carrier|customer|api, `actor_id`, `reason`, `created_at`) and emits `order.status_changed` + its specific event. Inventory: cancellation and rejection release the reservation, and `returned` does not return stock except through the existing restock step.

### 4.2 New fields on the order (migration)

| Column | Type | Source | Purpose |
| --- | --- | --- | --- |
| `status` | enum from the table above + index `(workspace_id, status, created_at)` | [EO] | Tabs and filters |
| `source` | enum `store`, `funnel`, `manual`, `api`, `import`, `upsell` | [LF] | "Source" column |
| `ipAddress`, `ipCountry`, `userAgent`, `visitorId` | string | [EO] [LF] | Protection and attribution |
| `attribution` | jsonb: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `referrer`, `landing_page`, `fbclid`, `ttclid`, `gclid`, `sclid`, `ad_id` | [EO] [LF] | "Attributions" card + profits |
| `sessionStats` | jsonb: `first_visit_at`, `sessions_count`, `pages_visited[]`, `time_to_purchase_seconds`, `orders_count` | [EO] | "Session details" card |
| `riskLevel` | enum `low`, `moderate`, `high` | [EO] | Section 5 |
| `riskScore` | int 0-100 | [Z+] | Section 5 |
| `dataQuality` | enum `ok`, `low` | [EO] | Data Quality column |
| `tags` | text[] | [LF] | Filtering and organization |
| `isSeen`, `seenAt` | bool, date | [EO] | "Seen" |
| `isTest` | bool | [LF] | The merchant's orders from their own browser (admin-specific cookie); not counted in analytics, fees, or the pixel |
| `paymentProofUrl`, `payerAccount` | string | [EO] | Transfer screenshot and sender number (section 11) |
| `archivedAt` | date | [LF] | Delete = archive; there is no real (hard) deletion |

New table `order_notes`: `id`, `workspace_id`, `order_id`, `body`, `visibility` (`internal`, or `public` which is shown to the customer on the tracking page), `author_user_id`, `created_at`. [EO]

### 4.3 Orders list (`OrdersListPage.tsx`)

- **Tabs** above the table: "All orders" + a tab for each `status` with its counter from `GET /orders/counts`, + two tabs `HIGH RISK` and `MODERATE RISK` that filter by `riskLevel`. [EO]
- **Columns**: order number, customer (name + number + "delivery rate" bar + "New customer" if they have no history), address, total, status, Data Quality, IP Country, source (funnel or store name), payment, shipping, date, tags, "seen" marker, Risk badge, Test badge. The merchant can hide and reorder columns (saved per user). [EO] [LF]
- **Search** (`q` exists): order number, name, mobile, waybill number.
- **Filters ("Add filter")**: date (from/to + shortcuts: today, 7 days, 30 days), product, governorate, payment method, source/funnel, shipping company, `riskLevel`, `dataQuality`, `ipCountry`, tag, discount code, `utm_source`/`utm_campaign`, seen/not seen, test. Filters are saved as "Saved views". [EO] [LF]
- **Pagination**: 25/50/100 per page + cursor.
- **Bulk actions** on the selection (or "all filter results"): update status, print selected (waybills or invoices), resend to webhook, ship selected (sends to the shipping company), add/remove tag, export, archive. [EO]
- **Top buttons**: "Create order" (manual), "Export", "Sync from file" (upload a CSV containing waybill numbers and statuses) [LF], "Refresh".
- **Pipeline page** (`OrderPipelinePage.tsx`) stops fetching 100 orders and sorting them in the browser; each column pulls from `GET /orders?status=` with the cursor, and drag-and-drop calls `PATCH /orders/:id/status`.
- **Export**: CSV or Excel, the merchant chooses the columns, the export runs in the `io` queue and the result is a download link in notifications + email [LF]. Option of "one row per product" or "one row per order".

### 4.4 Order page (`OrderDetailPage.tsx`)

**Header:** order number, last action and its time, status (a button that opens only the allowed transitions), previous/next order arrows [EO], and the buttons: "Edit order", "Confirm via WhatsApp", "Refund" [LF], "Cancel", "Copy order link" (customer page) [LF], "Resend to webhook", "Print" (invoice or waybill), "Archive". Opening the page marks the order `isSeen`.

**Cards:**

1. **Cart items**: image, name, variant, offer/bundle, quantity × price, Bump or Upsell badge, and the custom data (text or image the customer entered). A "Bundles" tab shows the selected bundle. [LF]
2. **Order summary**: payment method, sender number/account (for transfers), transfer screenshot, products subtotal, shipping, discount, total, paid, refunded. [EO]
3. **Shipping**: shipping company (from the enabled ones), city and area using the company's codes, notes for the courier, a "Save as draft" button and a "Send to shipping company" button. After sending: waybill number, tracking link, shipment timeline. Manual alternative: "Shipped" with a tracking number, a link, and product selection [LF]. [EO]
4. **Session details**: where they came from (referrer), pages they visited, time taken to purchase, number of sessions, first visit, first order. [EO]
5. **Attributions**: the order's sequence number for the customer ("First order"), total visits, source/medium/campaign/content/term. [LF]
6. **Customer data**: name, mobile (copy), email, "Customer delivery rate" bar (section 5.4), "Report as spam" button, "Block customer number" button, "Edit" button, link to the customer page and their previous orders. [EO] [LF]
7. **Shipping data**: governorate, address (copy), "View on map", IP + IP Country + "Block IP" button. [EO] [LF]
8. **Coupon and discount**: the code, discount amount, bundle discount shown separately from the code discount. [EO] [LF]
9. **Notes**: add a note + option "Show note to customer". [EO]
10. **Tags**. [LF]
11. **Timeline**: every status change, message sent, webhook, shipping update, edit, by whom and when. [Z+]

**Editing [LF]:** add products (select a product, then a variant), change quantity down to zero, preview the price difference before saving. Allowed only before the order is shipped, and adjusts the stock reservation within the same transaction. Address editing already exists (`updateOrderLimited`).

**Refund [LF]:** refunded quantity per line, the amount is calculated and can be edited manually, optional reason, "Notify customer". Exists in `POST /orders/:id/refunds`; what is missing is the lines and the notification.

**Cancellation [LF]:** reason from a list (customer cancelled, fake order, duplicate, out of stock, other), "Refund amount" option, "Notify customer" option.

**Confirm via WhatsApp [EO]:** if official WhatsApp is connected, send the confirmation template with buttons (section 14); if it is not connected, open `wa.me/<phone>?text=` with a prepared message.

### 4.5 Manual order [EO]

The same checkout form inside the dashboard: search for a customer by mobile or create a new customer, products + variants + offer, governorate (shipping is calculated automatically and can be edited), coupon, payment method, notes. Uses the existing `POST /orders` (with Idempotency-Key) with `source=manual`.

### 4.6 Required API (under `ws/orders`)

| Method | Path | Description | Permission |
| --- | --- | --- | --- |
| GET | `/` | Exists + the new filters above | orders.view |
| GET | `/counts` | Exists; returns a count per `status` + risk | orders.view |
| PATCH | `/:id/status` | `{status, reason?, notifyCustomer?}` | orders.manage |
| POST | `/bulk` | `{action, orderIds[] or filter, payload}`; action: `set_status`, `add_tag`, `remove_tag`, `ship`, `print_waybills`, `print_invoices`, `resend_webhook`, `archive` | orders.manage |
| POST | `/export` | `format` (csv or xlsx), `columns[]`, `filter`, `rowPer` (order or item) → job id | orders.view |
| POST | `/import-tracking` | CSV file: `order_number, tracking_number, tracking_url, carrier, status` [LF] | orders.manage |
| POST | `/:id/items/preview` and PUT `/:id/items` | Edit items with preview | orders.manage |
| GET/POST | `/:id/notes` | Notes | orders.view / orders.manage |
| GET | `/:id/timeline` | Merges status history + audit + messages + webhooks | orders.view |
| POST | `/:id/fulfill` | `{items[], trackingNumber, trackingUrl, carrierCode}` manual | orders.manage |
| POST | `/:id/resend-webhook` | Resends `order.created` to all endpoints | orders.manage |
| POST | `/:id/whatsapp-confirm` | Sends the confirmation template | orders.confirm |
| GET | `/:id/neighbors` | `{prevId, nextId}` based on the same filter | orders.view |
| GET | `/:id/invoice.pdf` | Invoice (invoices module exists) | orders.view |

And under `ws/customers`: `POST /:id/report-spam` and `POST /:id/block` (section 5).

## 5. Protection Against Fake Orders

This is the most important feature for a COD merchant, because every fake order costs them shipping both ways. What exists in ZIMOS (`orders/fraudRules.js`) is: a phone-number blacklist, a duplicate window, a daily order limit per number, a rejection-rate threshold, and a flag or block action. What is required is to be built on top of it in 5 layers.

### 5.1 Layer 1: Before the order is created (the visitor)

- **Blocked countries** [LF]: a visitor from a blocked country does not see the pages at all.
- **Blocked IPs** [LF]: same idea, with the date added and an "Unblock" button. The "Block IP" button exists on the order page.
- **Bot verification** [EO "Bot protection lock", LF Captcha]: on by default and the merchant can turn it off. Implementation: a hidden honeypot field + a time-based token signed by the server when the page is opened (an order submitted in less than 3 seconds is rejected) + invisible Cloudflare Turnstile. Whatever fails goes to "Lost orders" with reason `integrity_check`.

### 5.2 Layer 2: Checkout-time rules

**Scope boundary:** All rules are in scope. VPN detection and IP country go through an interface `ipIntel.lookup(ip) → {country, isVpn, isHosting}` with a `sandbox` adapter; the real provider is the integrations team's work.

All of them are stored in `workspace.settings.fraud_rules` (exists; we add the keys in `workspaceValidation.js`):

| Key | Type | Source | Behavior |
| --- | --- | --- | --- |
| `block_outside_country` | bool | [EO] | Rejects the order if `ipCountry` is not in `allowed_countries` (default: the store's country) |
| `allowed_countries` | string[] ISO2 | [EO] |  |
| `block_vpn` | bool | [EO] | IP from a VPN or hosting → lost order. The IP reputation provider is an **open decision** |
| `max_items_per_order` | int, 0 = unlimited | [EO] [LF] | Maximum number of units of a single product |
| `max_orders_per_phone_per_day` | int (exists) | [EO] | Within 24 hours |
| `min_minutes_between_cod_orders_per_ip` | int | [LF] | Minimum interval between two COD orders from the same IP |
| `duplicate_window_minutes` | int (exists) | [Z] | Same number + same product |
| `high_rejection_threshold` | int (exists) | [Z] | Number of previous rejections |
| `min_network_delivery_rate` | int % or null | [Z+] | If the customer's delivery rate is below it → the chosen action |
| `phone_validation` | `strict` or `off` | [EO] | Validation with libphonenumber according to the store's country (Egypt: 01x and 11 digits) |
| `action` | `flag`, `block`, `require_otp`, `to_lost` | [Z+] | One action per rule, not a single action for all |

The `action` becomes an object per rule: `{ "max_orders_per_phone_per_day": { "value": 3, "action": "to_lost" } }`. Make the validation accept the old shape as well (migration for the stored values).

### 5.3 Layer 3: The blacklist

A new table `blocked_entries` replacing the customer-only blacklist: `id`, `workspace_id`, `type` (`phone`, `ip`, `email`, `device`, `name_address`), `value` (normalized), `scope` (`orders`, `otp`, `visit`), `reason`, `created_by`, `created_at`. [EO has two separate lists: "Numbers blocked from ordering" and "Numbers blocked from OTP", plus blocking by name and address; LF has IP and country blocking]

- `GET/POST/DELETE ws/fraud/blocklist` (the DELETE does not exist currently), with a filter by type and scope, and import from CSV.
- The existing `customers.isBlacklisted` stays working and gets linked: blocking from the customer page adds a `phone` row.

### 5.4 Layer 4: Platform-wide customer delivery rate [EO]

EasyOrders shows on every order a "Customer delivery rate" calculated from all stores on the platform, not a single store, and based on orders that were **actually delivered**, not those that were confirmed. This is a competitive feature built on data volume, and we must start collecting its data from day one.

- A table **without** `workspace_id` (platform level): `customer_network_stats` — `phone_hash` (sha256 of the number in E.164 format + a secret pepper in env), `orders_total`, `delivered`, `returned_to_sender`, `cancelled_after_confirm`, `rejected`, `spam_reports`, `stores_count`, `first_seen_at`, `last_seen_at`.
- Updated by the worker on `order.delivered`, `order.status_changed` (for `returned_to_sender`), `order.rejected`, and the "Report as spam" button. `isTest` orders are not counted.
- Rate = `delivered / (delivered + returned_to_sender + cancelled_after_confirm)`. If the denominator is zero → "New customer (no orders)".
- **Privacy**: the merchant sees aggregated numbers only (the rate + order count + the bar), and does not learn which stores the customer bought from. The table does not contain the phone number itself. A clause in the terms of use explains the use of aggregated data (**open decision, legal**).
- Display: a 4-segment colored bar in the list and on the order page + tooltip "Delivered X of Y orders". A recommendation to the merchant appears if the rate is below 50%: "Ask for a deposit or for the shipping fees upfront" [Z+]. The endpoint: `GET ws/customers/:id/network-score` + the field is returned inside the order and the list.

### 5.5 Layer 5: Risk scoring and data quality

`riskService.score(orderDraft, context)` runs before the order is saved and returns `{ score, level, reasons[], dataQuality }`. The weights are a starting point and will be tuned after launch:

| Signal | Points |
| --- | --- |
| Phone number is not valid for the country | +40 |
| Name shorter than 3 characters, or random characters, or offensive words | +20 |
| Address shorter than 10 characters or the same word repeated (e.g. "Aswan Governorate Aswan Governorate") | +15 and `dataQuality=low` |
| `ipCountry` differs from the store's country | +25 |
| VPN or hosting IP | +25 |
| Order submitted less than 10 seconds after opening the page | +20 |
| More than two orders from the same IP or device within an hour | +20 |
| Network delivery rate below 40% (with 3 or more orders) | +30 |
| `spam_reports` greater than zero | +15 per report, max 45 |
| Email from a temporary (disposable) domain | +10 |

`level`: below 30 = `low`, 30 to 59 = `moderate`, 60 and above = `high`. The level is only a marker and takes no action unless the merchant enables the rule "High risk → OTP or lost" [EO only sets the marker].

**AI check (P2, behind a FeatureFlag)** [EO Spam Shield]: for `moderate` orders only, we send the name, address, and notes (without the number) to a language model that returns `{is_gibberish, is_abusive, address_complete}` via the `ai` queue. The result adds points and does not delay the order.

### 5.6 OTP verification via WhatsApp or SMS [EO]

- Settings `settings.checkout_otp`: `enabled`, `channel` (`whatsapp` or `sms`), `apply_to` (`all`, `cod_only`, `risky_only`), `code_length` (4-6, default 4).
- The implementation uses the existing `otp/otpService.js` (hashed, 5 minutes, 5 attempts, 3 sends/10 minutes) with a new purpose `checkout`, and we add a WhatsApp channel (an authentication-type template from Meta).
- The flow: the customer clicks "Order now" → the server creates a `CheckoutSession` with status `awaiting_otp` and sends the code → code-entry screen (with "Resend" after 60 seconds and "Change number") → successful verification creates the order.
- An order that was not verified remains a "lost order" with reason `otp_unverified`: **no pixel, no fees, and no stock reservation**. Numbers in the blocklist with scope `otp` are not sent a code.

### 5.7 Protection screen (`FraudProtectionPage.tsx`)

It is taken off the mock and becomes 4 tabs:

1. **Rules**: every key from 5.2 with a switch + value + action, plus OTP, bots, and countries blocked from visiting.
2. **Suspicious orders**: from `GET /fraud/flagged-orders` with the reasons, and the buttons "Approve" (exists) and "Block and cancel" (new: `POST /fraud/flagged-orders/:id/block`).
3. **Blocked**: the `blocked_entries` table with type and scope filters + add + delete + import.
4. **Statistics**: number of orders prevented, and the estimated money saved (count × average round-trip shipping cost) [Z+].

## 6. Lost Orders and Recovery

EasyOrders calls them "Lost orders" (every order that was not completed for any reason), and Lightfunnels calls them "Checkouts" (abandoned carts + recovery status). ZIMOS combines both in a single screen built on the existing `CheckoutSession`.

### 6.1 Data

Additions to `checkout_sessions`:

- `status`: we add `awaiting_otp` and `lost` to the existing values (`in_progress`, `converted`, `abandoned`).
- `lostReason`: `incomplete` (did not click order), `invalid_data` ("Incorrect data entry" [EO]), `integrity_check` (bot), `otp_unverified`, `outside_country`, `vpn`, `blocked`, `limit_exceeded`, `payment_failed`.
- `reviewStatus`: `under_review` or `completed` (the merchant has viewed or recovered it) [EO].
- `recoveryStatus` exists (`not_contacted`, `contacted`, `recovered`, `lost`) [LF].
- `recoveryToken` (random, for the recovery link), `ipAddress`, `ipCountry`, `attribution`.

**Lost orders are not counted in fees, do not fire Purchase to the pixel, and do not reserve stock.** [EO]

### 6.2 The storefront must send the sessions

Currently `apps/storefront` does not call `POST /store/:ws/checkout-sessions` at all. Required:

1. As soon as the customer types a valid mobile number or a name (debounce 800ms), with the `sessionId` stored in sessionStorage.
2. On every change to the cart or the address.
3. When the checkout is rejected because of a rule (section 5), the server itself moves the session to `lost` with the reason.
4. The cron `checkout.detect_abandoned` moves sessions with no activity for 15 minutes to `abandoned` [LF] (currently 30 minutes; the value becomes a setting `abandoned_after_minutes`).

### 6.3 The screen (`AbandonedCheckoutsPage.tsx` is renamed to "Lost orders")

- Tabs: All, Under review, Completed, Recovered. [EO] [LF]
- Columns: status, name, mobile, reason, products, total, recovery status, date.
- Filters: date, reason, product, source (funnel/store).
- Per-row actions: "WhatsApp" (recovery template with a `/r/:token` link), "Call" (`tel:`), **"Convert to order"** (opens the manual order form pre-filled with the data), "Change recovery status", "Delete". [EO converts a lost order to confirmed]
- Bulk: Excel export with a date filter, delete. [EO]
- Top of the screen: number of lost orders, lost-order rate relative to visits, money recovered this month. [EO statistics panel]

### 6.4 Automatic recovery [LF Cart Recovery]

- Recovery is built as an **automation** (section 14) on the `checkout.abandoned` event, with sequential steps and a delay for each step. Default example: WhatsApp after 30 minutes, and if the customer did not come back, WhatsApp with a coupon after 24 hours.
- Channels: WhatsApp template, SMS, email (if there is an email). Each message accepts variables: `{{customer_name}}`, `{{product_name}}`, `{{cart_total}}`, `{{recovery_link}}`, `{{coupon_code}}`.
- The sequence stops automatically if the customer places an order with the same number.
- **Recovery link** `GET /r/:token` in the storefront: rebuilds the cart, fills the form, and applies the coupon if present. An order that comes from it sets the session to `recovered` and emits `checkout.recovered`.
- Consent: recovery messages are marketing; they contain an unsubscribe link/keyword, and are not sent to numbers in the blocklist.
- Google Sheets sync for lost orders (section 16) [LF].

### 6.5 The API

- `GET ws/checkout-sessions` exists; we add the filters `lostReason`, `reviewStatus`, `from`/`to`, `productId`.
- `PATCH ws/checkout-sessions/:id` exists; we add `reviewStatus`.
- `POST ws/checkout-sessions/:id/convert` → creates an order with `source=manual` and links it via `convertedOrderId`.
- `POST ws/checkout-sessions/export` and `DELETE ws/checkout-sessions/:id`.
- In the storefront: `GET /store/:ws/recover/:token` returns the cart and the data.

## 7. Products and Catalog

The catalog in ZIMOS works (Product → ProductVariant → Offer, and Collection), but it lacks the product page settings that make the difference in conversion, and the structured product content (features, FAQs) that gets bound to pages.

### 7.1 Product fields

| Field | Source | In ZIMOS | Required |
| --- | --- | --- | --- |
| Name, description (rich text + zoom), images | [EO] [LF] | Exists (`media` jsonb) | mp4 video up to 50MB and images up to 10MB, drag-and-drop and reordering |
| Link (slug), SKU | [EO] [LF] | Exists | Nothing |
| Meta description | [EO] | `seo` jsonb | Show it in the form |
| Price, sale price (compare at), cost | [EO] [LF] | On the variant | Cost feeds into net profit (section 15) |
| Display priority (number, highest first) | [EO] | Missing | `priority` int |
| Categories | [EO] | Collections | Nothing |
| Tags | [LF] | `tags[]` | Nothing |
| "Special offer" (text above the buy button) | [LF] | Missing | `specialOfferText` |
| Product type: physical or digital | [EO] [LF] | `productType` | Digital delivery (section 18) |
| Billing model: one-time, subscription, installments | [LF] | Missing | `billingModel` + `billingConfig` (section 18) |
| Product-specific currency | [EO] | Missing | `currency` override (section 11) |
| Product-specific Pixel | [EO] | Missing | `pixelOverrides` (section 13) |
| Shipping group | [LF] | Missing | `shippingProfileId` (section 12) |
| Price bundle | [LF] | Offers | `bundleId` (section 10) |
| Order bumps for the product | [LF] | Missing | Section 10 |
| Linking to external platforms (Taager, Anjezni) + the product code there | [EO] | Missing | `externalRefs` jsonb (section 16) |
| Inventory: quantity, tracking, disable when out of stock | [EO] [LF] | Exists (`allowOverselling`, `lowStockThreshold`) | Present them more simply |

**Custom Data [LF]:** Fields the customer fills in (a name to be printed on the product, a logo image). `customFields[]`: `{key, type: text|image, label, required, maxLength, priceDeltaAmount}`. The values are stored in `order_items.customData` (new column) and appear on the order page and the shipping waybill.

### 7.2 Variants

- Options (`Product.options`): each one has a `displayType`: `dropdown`, `buttons`, `color` (color swatch with hex), `image` (an image per value). [EO] [LF]
- "Variant control" screen [EO] / bulk edit [LF]: a table of all variants (price, sale price, cost, quantity, SKU, image, active/hidden) with multi-select and applying a value to the selected rows.
- A variant with zero stock appears struck through and cannot be selected in the store. [LF]
- Store setting "Disable automatic variant selection" (the customer must choose themselves). [EO]

### 7.3 Product page settings (`Product.pageSettings` jsonb) [EO]

| Key | Type | Behavior |
| --- | --- | --- |
| `skip_cart` | bool | The "Buy now" button goes directly to checkout ("Buy Now" exists in the backend) |
| `buy_now_text` | string ≤ 40 | Button text |
| `sticky_buy_button` | bool | Fixed button at the bottom of the screen on mobile |
| `inline_checkout` | bool | Purchase form inside the product page (the most important one for COD) |
| `checkout_before_description` | bool | Form above the description |
| `reviews_enabled` | bool | Show reviews |
| `free_shipping` | bool | Free shipping for this product only |
| `hide_header` | bool | Landing page without a header |
| `hide_quantity_selector` | bool | Hide the quantity selector |
| `hidden` | bool | The product does not appear in listings; it opens only via its link |
| `hide_related_products` | bool | Hide "Similar products" |
| `landing_page_id` | uuid or null | A landing page built with the builder instead of the template ("Create a professional landing page for the product") |
| `countdown` | `{ends_at}` or null | A countdown for a real offer that actually ends (the server reverts the price after it) |

Fake counters (fake visitors, fake stock, a countdown that restarts from the beginning, a fake pixel price) exist in EasyOrders and **we will not build them** (section 21).

### 7.4 Structured product content (Product CMS) [LF]

`Product.cms` jsonb: `features[] {title, description, image}`, `testimonials[] {name, text, image, rating}`, `faqs[] {question, answer}`. The builder binds elements to them via data binding (section 9.4), so a single template works for any product. Testimonials here must be real reviews entered by the merchant; there is no AI generation of them.

### 7.5 Product list

- Search by name and a separate search by SKU, filters (status, category, stock, type). [EO] [LF]
- Columns: image + name, stock ("Not tracked" if tracking is off), price, creation date, a preview-in-store button, a "Duplicate" button. [EO] [LF]
- Bulk: bulk edit (price, free shipping, category, status), JSON export, delete (archive). [EO]
- Import: **Excel file** (downloadable template with the columns), **JSON file** (same shape as the export, for moving between stores) [EO], **product link** from Shopify, AliExpress, Amazon, Etsy, CJ or YouCan [LF]. All of it runs in the `io` queue with a report of the rows that failed. Import from link starts with Shopify (public JSON data `/products/<handle>.json`); the remaining sources are an **open decision** (they need a scraping provider or an official API).

### 7.6 Categories [EO]

Additions to `collections`: `imageUrl`, `parentId` (subcategories), `showInHeader`, `position`, `hidden`. The list shows: image, name, number of subcategories, "Shown in header", preview, edit, export.

### 7.7 Reviews

- Exists: a review linked to a delivered order + merchant moderation. Missing:
- **In the store**: display approved reviews (average + count + list with photos) and an add-review form with a photo. `POST /store/:ws/products/:id/reviews` exists.
- **Manual addition** from the dashboard (name, rating, comment, photos) for real reviews that came through another channel (WhatsApp, comments). A manual review does not show a "Verified buyer" badge. [EO] [LF]
- **Import** of the merchant's own product reviews from Shopify (link + filters: with photos only, minimum rating, language). [LF]
- Automatic review request on WhatsApp N days after delivery (automation, section 14) [Z+].

### 7.8 Product Feed [EO]

- "Product Feed" screen: choose a Channel (`meta`, `google`, `tiktok`, `snapchat`) → a fixed link that updates automatically `GET /feeds/:workspaceSlug/:channel.xml` (or csv).
- Fields according to each platform's specifications: `id` (the variant), `item_group_id`, `title`, `description`, `link`, `image_link`, `additional_image_link`, `price`, `sale_price`, `availability`, `brand`, `condition`, `google_product_category`.
- Filter: specific categories, exclude hidden and sold-out items. Built in the cron `feeds.rebuild`.
- **Google Merchant** [EO]: a page that ensures the store has what is required for approval (company email, phone and address, shipping policy, return policy, cash-on-delivery policy) and checks them before enabling the feed. It uses the data from section 8.5.

### 7.9 Interactive catalog (Easy Catalog) [EO] — P2

A single image (e.g., a complete bathroom) with clickable points, each point linked to a product. Table `shoppable_images`: `imageUrl`, `hotspots[] {x%, y%, productId}`, `title`, `slug`. It has a shareable public page + an element in the builder.

### 7.10 The API (under `ws/catalog`)

The existing endpoints stay. We add: `POST /products/bulk` (bulk edit), `POST /products/:id/duplicate`, `POST /products/import` (file or link, returns a job), `GET /products/export.json`, `PATCH /products/:id/variants/bulk`, `POST /reviews` (manual), `POST /reviews/import`, CRUD `/feeds` and `/shoppable-images`.

## 8. Store Design and Settings

The real store in ZIMOS is `apps/storefront` (Next.js), and the backend gives it `themeSettings` (blob) + the page engine's pages. This section defines everything the merchant controls about the store's appearance.

### 8.1 Themes [EO]

- A theme gallery with two sections: "Modern themes" (multi-product brand stores) and "Classic library" (single product and landing pages). Filter: All / Free / Paid, and categorization by niche (fashion, furniture, pets, kids, electronics).
- Each theme: mobile + desktop image, name, tags, price, "Preview" and "Activate" buttons, and a "Reset" button for the current theme. A paid theme is a one-time purchase from the wallet.
- Implementation in ZIMOS: a theme = React code inside `apps/storefront/src/themes/<key>/` (layout, product page, listing, cart) + a `schema.json` file with the settings it accepts. `themeSettings` stores `{ themeKey, tokens, sections }`. A `themes` table in the backend (platform-level catalog): `key`, `name`, `kind` (`store` or `landing`), `category`, `priceAmount`, `previewImages`, `isActive`. A `workspace_themes` table for purchased themes.
- Custom themes with code (EO has a CLI and Liquid): **P2**. The first alternative is "Upload design files" (8.4).

### 8.2 Homepage builder [EO]

It opens on the store itself (`/home-builder`) with a live preview, a sidebar with components, drag-and-drop and reordering, a desktop/mobile toggle, "Preview", "Save". Component groups:

| Group | Components | Equivalent in ZIMOS (`blocks.ts`) |
| --- | --- | --- |
| Text | Main heading and subheading, advanced text | `heading`, `rich_text` |
| Images and media | Slider, image, promotional banner | `image`, `gallery`, **new** `slider`, `banner` |
| E-commerce | Categories, featured products, product list, product grid | `collection_list`, `product_list` (source featured/newest/best_selling), **new** carousel or grid display |
| Other elements | Simple section, advanced section, HTML code | section, **new** `custom_html` (8.4) |
| FAQs | FAQ | `faq` |
| Store features | Icons + text (warranty, delivery, returns) | **new** `features_row` |
| Custom categories | Category images with free-form design | **new** `custom_categories` |
| Reviews | Customer testimonials | `testimonial` or binding to real reviews |
| Custom promotional banners | Multiple banners with links | **new** `banner_grid` |

Implementation: the same page engine (`WebsitePage` with `pageType=home`), but the editor must have a live preview (an iframe of the store in `?preview=draft` mode + postMessage) instead of the current form. The full editor is in section 9.

### 8.3 Pages and policies

- **Pages** [EO]: a table (title, link, shown in header, shown in footer, active, preview, edit). We add `showInHeader`, `showInFooter`, `isActive` to `website_pages`. A fixed tip on the screen: "Shipping, returns and privacy policies are required for TikTok ads".
- **Policies** [LF]: refund policy, privacy, terms of service. A rich text editor + "Create from template" in Arabic and English, with the variables `{{store.name}}`, `{{store.address}}`, `{{store.email}}`, `{{store.phone}}`. Written once and shown in the store footer, all funnels, and the checkout page. Stored in `settings.legal`.

### 8.4 Code customizations [EO]

- **UI Blocks**: fixed slots where the merchant places HTML: above the header, below the header, above the image gallery, below the image gallery, above the purchase form, below the purchase form, above the footer, below the footer. Each slot has an "Enable" switch + an HTML editor.
- **Head code**: a code box injected into `<head>` (external tracking tools, domain ownership verification).
- **Upload design files**: CSS and JS files loaded on all store pages.
- **Security (decision)**: the backend currently rejects any raw HTML in the page tree, and that is correct. Custom code is stored **outside the tree** in `workspace_custom_code` (`slot`, `html`, `isActive`, `updatedBy`), and is served only on the store domain (not inside the dashboard, nor in the preview that carries tokens). The permission is `website.publish`, and every edit is recorded in the audit log. It must never run on the card payment page.

### 8.5 Store information and policies [EO]

`settings.store_info`: enable, store email, store phone, company address, shipping policy (title + bullet-point content, example: "Delivery within 2-5 business days"), return policy, cash-on-delivery policy (with an option to disable it). Shown as trust cards under the buy button, and used by Google Merchant.

### 8.6 Purchase form (Checkout form builder) [EO]

The existing `settings.checkout_settings` contains only `email`, `alternate_phone`, `notes`. It is replaced by `checkout_settings.fields[]`, each field: `key`, `label` (Arabic + English), `helpText`, `position`, `enabled`, `required`.

Fixed keys (exactly like EasyOrders): `full_name`, `phone`, `country`, `government` (governorate), `city` [Z+], `email`, `address`, `phone_alt`, `note`, `sa_national_address` (Saudi national address). `full_name` and `phone` cannot be disabled. + custom fields defined by the merchant (`custom_1`... of type text or choice) [Z+].

Other settings on the same screen: `allow_discount_codes` (exists), `thank_you_message` (exists), `layout` (`one_step` or `inline_on_product`), `show_trust_badges`, and a fixed tip: "The fewer the fields, the higher the sales". The store (`lib/orderForm.ts`) renders the form from this array, and the backend validation reads it.

### 8.7 Thank-you page [EO]

`settings.thank_you_page`: `enabled`, `content` (rich text with the variables `{{order_number}}` and `{{customer_name}}`), `show_back_home_button`, `show_products_from_collection_id`. + post-purchase offer (section 10) + order tracking link. The Purchase pixel is sent from this page exactly once (section 13).

### 8.8 General store settings [EO]

| Setting | Where it lives in ZIMOS |
| --- | --- |
| Site language | `defaultLocale` (exists) |
| Main site title | `name` / SEO title |
| Announcement bar above the header (empty = hidden) | `themeSettings.announcement` |
| Primary color, font (a shortlist of recommended Arabic fonts) | `themeSettings.tokens` |
| Logo, 16×16 icon | `logoUrl` (exists) + new `faviconUrl` |
| Default shipping rate (0 = free) | `default_shipping_rate_amount` (exists) |
| Currency, country, time zone | Exists + new `country` |
| Disable automatic selection of shipping regions | `checkout_settings.auto_select_region` |
| Disable automatic variant selection | `checkout_settings.auto_select_variant` |
| Bot protection lock, item quantity limit, order limit per phone number | `fraud_rules` (section 5) |
| Social links (Facebook, Instagram, TikTok, WhatsApp, YouTube, Snapchat, X) | `settings.social_links` |
| Floating WhatsApp button | `settings.floating_whatsapp {enabled, phone, message}` [EO service from the gallery] |

### 8.9 SEO [EO] [LF]

- For each page/product/category: title, description, OG image, canonical, noindex (`seo` jsonb exists).
- At the store level: title template, description, default OG image, Google Search Console verification (meta tag).
- `sitemap.xml` and `robots.txt` generated automatically in Next (EO makes them an add-on; for us they are default). JSON-LD for the product (Product, Offer, AggregateRating from real reviews only).
- 301 redirects exist in the page engine.

### 8.10 Multi-language [EO] [LF]

- Fixed interface languages in the store: Arabic, English, French, Spanish, Italian, German [EO]. Initially Arabic + English + French (Morocco and Algeria).
- Merchant content (product names, descriptions, pages): a `translations` table (`entity_type`, `entity_id`, `locale`, `field`, `value`) + a "Translate with AI" button (section 19). A "Languages" screen shows the completion percentage for each language [LF shows English 62%].
- A language switcher in the store, and RTL is automatic for Arabic.

### 8.11 Domains

**Scope boundary:** the domains screen, TXT verification, Home funnel, and `resolve-host` in `proxy.ts` are in scope. Automatic SSL issuance and domain purchasing are the integrations team's work; the code builds an `sslStatus` field and a `certificateProvider` interface with a `sandbox` adapter only.

- Connect a domain [EO]: the domain without www, or a subdomain; clear CNAME instructions (name, type, value, TTL, "delete any conflicting record"), an explainer video.
- **Automatic SSL without the merchant having to create a Cloudflare account** (the current implementation requires them to). Recommendation: Cloudflare for SaaS (Custom Hostnames) or Caddy on-demand TLS. **Open decision**.
- Domain list [LF]: name, status, SSL status, Primary, "Home Funnel" (which funnel opens on the domain root), DNS propagation check.
- `apps/storefront/src/proxy.ts` must know the connected domains: it queries `GET /api/v1/store/resolve-host?host=` (new, cached) and rewrites to the store or to the funnel.
- Buying a domain from inside the dashboard with automatic DNS configuration [LF]: **P2**.
- "Powered by ZIMOS" in the footer is removed depending on the plan (`Plan.features.remove_branding`) [EO].

## 9. Funnels and the Page Builder (at Lightfunnels level)

The funnel engine in the backend is strong (steps + edges with conditions + revisions + a public runtime). Three things are missing: a real page editor, rendering the funnel in the store, and a real upsell. This section is the reference for both: the funnel editor (the map) and the page editor (the builder); the builder itself is also used for store pages.

### 9.1 Creating a funnel [LF] [EO]

A 3-step wizard:

1. **Template**: tabs (all templates, the ones you made, the ones you bought), filters (free/paid, category: COD, dropshipping, Advertorial, clothing, beauty, kitchen, furniture, kids, pets, courses, digital products, seasons such as Ramadan and Black Friday, language), sorting by newest or most used, usage count on each template. The first 3 cards are fixed: **Blank template**, **AI template** (from the product data, section 19), **Niche-specific template**. Each template has two versions, Arabic and English [EO]. A "Preview" button for each template.
2. **Type and product**: "Sell a product" or "Collect leads (Leads)", and choosing the product.
3. **Name, link and currency**.

Alternative: **Copy a funnel by code** [EO] / **Share** [LF]: every funnel has a share code; another merchant enters it and gets a copy (without the products and orders). `POST ws/funnels/import {shareCode}` and `POST ws/funnels/:id/share` and `POST ws/funnels/:id/duplicate`.

### 9.2 Funnel editor (the map) [LF]

`FunnelEditorPage.tsx` exists (dnd graph). It needs to reach the following:

- **Funnel tabs**: Overview (analytics), Build & Design (the map), Languages, Preview, Share, and the Published/Draft/Paused status.
- **Nodes (pages)**: each node shows a page thumbnail, its name, the linked product, and its numbers (Visits, CTR, Clicks) for a selected period.
- **Links (LINKS)**: every button, link or form inside the page appears as a point on the node ("Buy now", "Yes, add to my order", "No, thank you", "Pay now", "Express Checkout"), and the merchant drags an arrow from it to another page. The arrow becomes a `FunnelEdge` with the appropriate condition: buy button = `completed_checkout`, "Yes" = `accepted_offer`, "No" = `declined_offer`, any regular button = `clicked_through` with `sourceElementId` (a new field in `condition`).
- **Starting point** (Starting Page), and **generic pages** (Generic pages: contact us, about us, policies) in a sidebar, not on the map.
- **Split Test node** (9.6).
- **Tools**: pan the map by dragging, zoom in/out with the mouse wheel, "+" to add a page, dragging an arrow to an empty spot creates a new linked page.
- **Quality (Issues)**: an issue counter (page without a product, unlinked button, image without alt, untranslated text, missing policies). It builds on the existing `funnelGraph.validate` + content checks. Fatal issues block publishing (exists); the others are warnings.
- **Saving**: Save, Revert, Clone, and an **auto-saved draft** (if the browser was closed, it asks "Load draft?" or "Start over"). The draft lives on the server, not in localStorage: `funnels.draftData` jsonb + `draftUpdatedAt`.

**Page types** (the reference is `stepType` in the backend; we add `article`):

| `stepType` | Name [LF] | Function |
| --- | --- | --- |
| `sales` | Product Page | Product display + variant selection + bump, and optionally a COD form inside it |
| `checkout` | Checkout | Details form + payment + bump |
| `upsell` | Upsell | One-click offer after purchase (offerId mandatory, exists) |
| `downsell` | Downsell | A cheaper offer if the upsell is declined |
| `article` | Article | An article (advertorial) before the product page **new** |
| `opt_in` | Squeeze | Collect name/email/mobile (Lead) |
| `landing` | Landing | General landing page |
| `thank_you` | Thank you | End of the funnel + Order Summary |
| `custom` | Generic | Generic pages |

The `order_bump` in the mock is not a page; it is an element inside a sales or checkout page (9.5).

### 9.3 Page editor (the builder) [LF]

This is the largest piece of work in the document. The current editor (`WebsiteEditorPage.tsx`) is a list of sections + a form. What is required is a visual editor over the same data tree (section → row → column → element), with `container` added.

**Interface:**

- **Top bar**: back, previous/next page in the funnel, page list, product selection + "Edit product", devices (desktop, tablet, mobile), Undo/Redo (Ctrl+Z, Ctrl+Shift+Z), X-Ray (element outlines), Popups, Preview, Save.
- **Sidebar**: add elements (categorized + search), ready-made sections, layers (Layers: a tree with drag to reorder), global styles, page settings.
- **Canvas**: an iframe rendering the same store components (true WYSIWYG), double-click to edit text in place, an element menu (duplicate, delete, select parent, save as global section). The editor sends the tree to the iframe via postMessage.
- **Element panel** with 3 tabs: Content, Style, Layout.

**Elements** (the backend currently has 29 types; those marked "new" are added to `ALLOWED_ELEMENT_TYPES`, `PAGE_ELEMENT_TYPES` and `ELEMENT_SPECS`, with per-type props validation instead of "any object"):

| Group | Elements |
| --- | --- |
| Text | `heading`, `text`, `rich_text`, `list` + `list_item` (new), `text_link` (new) |
| Media | `image`, `video` (YouTube, Vimeo, mp4), `gallery`, `image_gallery` with thumbnails (new), `carousel` (new), `icon` |
| Layout | `section` (Wide, or Boxed at 1200px width), `row` (up to 12 columns), `column` (width 1-12 per device), `container` flex (new), `spacer`, `divider`, `masonry_grid` (new), `sticky_container` (new) |
| Interaction | `button` (page link, external link, submit, open popup, add to cart, buy now, accept/decline offer), `accordion`, `faq`, `tabs` (new), `toggle` (new), `countdown` (fixed date), `popup` (new, managed from the Popups button) |
| Forms | `form`, and inside it: `input_text`, `input_textarea`, `input_checkbox`, `input_select`, `input_file`, `stars_selector`, `label` (all new) |
| Product | `product_card`, `product_list`, `collection_list`, `variant_selector` (new), `bundle_selector` (new, section 10), `price` (new, bound to the variant), `stars_display` (new), `reviews_list` + `review_form` (new), `currency_converter` (new) |
| Checkout | `cod_form` (new: the form built from 8.6), `payment_form`, `express_checkout`, `order_bump`, `shipping_address`, `billing_address`, `checkout_summary` (with a coupon field), `order_summary` (on the thank-you page), `upsell_accept_button` and `upsell_decline_link` — all new |
| Advanced | `repeater` (new, 9.4), `map`, `social_icons`, `testimonial`, `comparison`, `marquee`, and the existing immersive elements in the backend (`shader_hero`, `product_3d`, `orbit_gallery`, `scroll_story`) |

`custom_html`: forbidden inside the page tree; its replacement is "Page scripts" in the page settings, under the same rules as 8.4.

**Style tab** (per element, depending on its type): color, font (family, size, weight, line height), borders (type solid/dashed/dotted/none, thickness, radius, color), dimensions (width, height, min, max), shadow (inner/outer, color, x, y, blur, spread), background (color, gradient, image), opacity, overflow, cursor, entrance animation (animation), **visibility per device** (desktop, tablet, mobile portrait, mobile landscape).

**Layout tab**: padding, margin, alignment (horizontal and vertical), flex direction, gap.

**Responsive** [LF]: design is done on desktop, and any edit made while on tablet or mobile is stored as an override for that device only. Data shape: `element.settings.style = { base: {...}, tablet: {...}, mobile: {...} }`.

**Global styles** [LF]: named colors, font sizes and buttons (e.g., Primary, H1); any change to them is reflected in every element in the funnel that uses them. Stored in `globalStyles` (exists), and the element references them via `styleRef`.

**Smart sections** [LF]: "Save as global section" (available across all funnels and the store; editing it once changes all copies) and "Save as smart element" (within the same funnel), plus a "Separate" button (Detach). Table `saved_sections` (`workspace_id`, `scope` global or funnel, `funnel_id`, `name`, `type`, `tree`), and the element in the page is `{type: "saved_ref", refId}`.

**Ready-made sections**: Hero, features, before/after, testimonials, FAQs, guarantee, CTA, COD form, footer — from the seeders.

**Page settings** [LF]: Details tab (the link using letters, digits and hyphens, internal title, type, product), SEO tab (title, description, OG), Scripts tab (code in head and code before `</body>`).

### 9.4 Data binding [LF]

- Every text or image element has a "Bind" button in the Content tab that chooses a source: `product.title`, `product.description`, `product.price`, `product.compare_at`, `product.images[n]`, `product.special_offer_text`, `store.name`, `store.phone`, `legal.refund_policy`... The value is stored as `props.binding = "product.title"` and the store renders the real data.
- **Repeater**: "Repeat for each" chooses a list (`product.cms.features`, `product.cms.testimonials`, `product.cms.faqs`, `product.reviews`), and inside it a container whose elements are bound to the item's fields (`item.title`, `item.image`).
- Result: a single funnel template works for any product just by changing the product.

### 9.5 Upsell, Downsell and Order bump

- **One-click upsell** [LF]:
  - **With COD**: accepting the offer **adds the product to the same order** (one shipment, one collection) and updates the total, provided the order has not been shipped yet. This is a change from the current behavior (a new order linked via `linked_from_order_id`); the current behavior remains for online payment. `order_items.isUpsell = true` (exists).
  - **With card**: the first payment must save the payment method (Paymob card token, Stripe `setup_future_usage=off_session`), and the upsell charges it without re-entering the details (section 11).
  - The offer: product + variant (chosen by the customer) + special price + quantity + optional real countdown. Uses the existing `Offer`.
- **Downsell** [LF]: same idea, on the `declined_offer` edge.
- **Order bump** [LF]: a checkbox on the product page or checkout: "Add X for Y instead of Z". Configured from the product ("Order bumps → Add new") or from the element. Details in section 10.3. `order_items.isOrderBump` exists.

### 9.6 Split tests [LF]

- A "Split test" node on the map before any page: it has 2 or more variations, each variation with a distribution percentage (totaling 100%) and linked to a page (a copy of the original via "Duplicate").
- The visitor is pinned to the same variation (`experiment_assignments` by `visitorId`, exists).
- Metrics per variation: visits, orders, conversion rate, revenue, EPC. A simple statistical confidence indicator [Z+].
- **Choosing the winner**: manual, or "Pick the winner automatically after N visits" (e.g., 2000) based on the chosen metric.
- Backend: `Experiment` and `ExperimentAssignment` exist without routes. We add CRUD under `ws/experiments` + the columns `trafficSplit`, `autoWinner {enabled, afterVisits, metric}`, `winnerVariantKey`. The runtime in `funnelRouting.js` passes through the experiment when it reaches the node.
- **A/B for products** [EO]: the same engine with `subjectType=product_page` (e.g., testing two prices or two images). A price test must pin the price for the visitor and be computed on the server.

### 9.7 Funnel settings

- Currency (per funnel), domain or subdomain (`Funnel.subdomain` exists), pixels used (selected from the account's pixels), available payment gateways, shipping group, languages, favicon, funnel-level scripts. [LF]
- **Home funnel** [LF]: a single funnel that opens on the domain root instead of the store.
- **Redirect by country** [LF GoIncognito]: rules "from funnel X → to funnel Y for visitors from countries [Egypt, Saudi Arabia]"; everyone else sees the original. Table `geo_redirects` (`sourceFunnelId`, `targetFunnelId`, `countries[]`, `isActive`). Useful for a different currency, language and shipping per country.
- **Languages** [LF]: translation of the funnel texts per language with a completion percentage, and a "Translate missing with AI" button.

### 9.8 Rendering in the store (the biggest gap)

- New routes in `apps/storefront`: `/f/[funnelSlug]` (or the subdomain or the domain) and `/f/[funnelSlug]/[stepKey]`.
- The first visit calls `POST /store/:ws/funnels/:ref/sessions` (exists) and saves `sessionId` in a cookie; every outcome (purchase, accept, decline, click) calls `advance` (exists) and goes to the step it returns.
- The renderer uses the same existing `page-renderer`, with the new elements and the bindings.
- Each step sends `page_view` + the events (section 13) with `funnelId` and `stepKey` so that page analytics work.
- The existing upsell page `/offer/[orderId]` is removed from `mockCommerce.ts` and becomes part of the runtime.

### 9.9 Funnel analytics (Overview tab) [LF]

Visitors, orders, revenue, EPC (revenue ÷ visitors), conversion rate, a daily sales chart, and a "Page performance" table (page, visits, CTR, CR, Opt-ins). Source: `GET ws/analytics/funnels/:funnelId` (exists) + the events from 9.8.

## 10. Offers and Marketing Tools

All offers are calculated on the server inside `orderService` (the existing pricing), and the store only displays them. `mockCommerce.ts` is deleted entirely at the end of this section.

### 10.1 Price bundles (Quantity bundles) [LF] [EO]

The idea: "Buy 1 for X, 2 at 5% off, 3 at 10% off". ZIMOS has `Offer` + `OfferVariant` per product; what is missing is making the bundle **reusable across multiple products** [LF].

- `bundles` table: `id`, `workspace_id`, `name`, `displayStyle` (`cards` or `dropdown` [EO] or `radio`), `isActive`.
- `bundle_tiers` table: `bundle_id`, `position`, `title` ("Buy 2 and save 5%"), `quantity`, `discountType` (`percentage`, `fixed_price`, `fixed_amount_off`, `buy_x_get_y`), `discountValue`, `label` ("Best seller"), `stickerText`, `sku` (for tracking and integrations), `freeShipping` (bool) [EO: free shipping from a certain quantity], `isDefault`.
- `products.bundleId` (the linked bundle). The existing `Offer` remains for single-product offers (specific variant combinations).
- **Creation screen** [LF]: bundle name → "Choose a template" (percentage discount, fixed price, buy X get Y, custom) → tiers (default 4: 0%, 5%, 10%, 15%) with "Add tier" → **live preview** next to the form showing the calculated prices.
- **In the store** [EO]: the customer selects the tier, and if the product has variants they **choose a variant for each unit** (e.g., one red unit and one blue unit). The bundle is added to the cart without clearing what is already in it.
- The order stores a separate `discountsSnapshot` for the bundle discount versus the coupon discount [LF `bundle_discount_value` and `normal_discount_value`].

### 10.2 Cross-sell [EO]

- After adding to cart or on the cart/checkout page: "Customers who bought this also bought". Rules: `cross_sell_rules` (`triggerProductIds[]` or `triggerCollectionIds[]` → `offerProductIds[]`, `discountType`, `discountValue`, `placement` (`cart`, `checkout`, `thank_you`), `maxItems`).
- Automatic alternative: the products most frequently bought together with the product, based on order history [Z+].
- The "Cross-sell add count" statistic in the analytics dashboard comes from the `add_to_cart` event with `source=cross_sell`.

### 10.3 Order bump [LF]

- `order_bumps`: `workspace_id`, `productId` (the product it appears on, or null = all products), `bumpProductId`, `bumpVariantId`, `priceAmount` or `discountPercent`, `headline` ("Add a charger for only 99 EGP"), `description`, `image`, `preChecked` (default false), `position`.
- Appears as a checkbox above the order button in the COD form and in checkout, and becomes a line item in the order with `isOrderBump=true`.
- A product can have more than one bump (maximum 3).

### 10.4 Post-purchase offer and exit Downsell

- **Post-purchase upsell** on the store's thank-you page (not the funnel's): same logic as 9.5 (added to the same order for COD). The rule comes from `upsell_rules` (order product → offer). The existing `/offer/[orderId]` page is wired to it.
- **Exit Downsell** [EO]: a popup with a message + coupon that appears on exit intent (mouse leaves the page on desktop, or the back button on mobile) or after N seconds. Settings: `enabled`, `trigger` (`exit_intent` or `delay`), `delaySeconds`, `title`, `message`, `discountId`, `pages` (product, cart, all), once per visitor.

### 10.5 Coupons [EO] [LF]

The `discounts` module in ZIMOS is stronger than both (percentage, fixed, free shipping, BXGY, minimum, product/collection/customer/funnel restrictions, date, usage limit, per-customer limit, stackable). What is missing:

- "Generate random code" button + bulk generation (N codes at once for influencer campaigns). [LF]
- "Once per customer" is determined by mobile number **or** email. [LF]
- **Automatic discounts without a code** (`isAutomatic`) applied when the conditions are met. [Z+]
- "Enable coupons for your store" global switch (= the existing `allow_discount_codes`). [EO]
- A share link that applies the coupon automatically: `?coupon=CODE`. [Z+]

### 10.6 Free shipping and minimum order amount [EO]

- `settings.free_shipping_threshold_amount` exists. We add `settings.min_order_amount` (an order below it is rejected with a clear message).
- Progress bar in the cart and checkout: "You're 150 EGP away from free shipping".
- Free shipping is applied in checkout, not only on the product page, and its sources are: the store threshold, the product (`free_shipping`), a bundle tier, a coupon.

### 10.7 Sales notification (Social proof) [EO]

- A small popup in the corner of the page: "Ahmed from Mansoura bought [the product] 12 minutes ago".
- **From real orders only** (last 7 days, confirmed or later), first name only + governorate, and the merchant can hide the name. If there are not enough orders, the popup does not appear. We will not build the fabricated-names version (section 21).
- Settings: `enabled`, `position`, `delaySeconds`, `intervalSeconds`, `maxPerSession`, `pages`, `showName`, `showCity`. Public endpoint: `GET /store/:ws/social-proof` (cached for one minute).

### 10.8 Referral links and UTM [EO]

- **Referral links for marketers**: choose a product + the marketer's code (`ref1`) → link `?ref=ref1`. The order is recorded with `attribution.ref`. Builds on the affiliate module (section 20).
- **UTM builder**: campaign link + source (facebook, tiktok, snapchat) + campaign name → a ready-to-copy link. Frontend-only tool.

### 10.9 Collecting emails and phone numbers (Newsletter) [EO]

- Subscription form in the footer or a popup: name, mobile, email, in exchange for an optional coupon. Creates a contact of type `lead` (section 18) with `marketingConsent=true`.
- Settings: placement, required fields, coupon, delay, text.

### 10.10 Web notifications for customers (Web push) [EO] — P2

Permission request in the store → push campaigns from the dashboard (title, body, image, link, audience). VAPID + Service Worker in the store.

### 10.11 Offers screen (`OffersPage.tsx`)

Becomes a single hub with tabs: Bundles, Order bumps, Cross-sell, Post-purchase upsell, Exit downsell, Sales notification, Free shipping. Each offer shows its own numbers (impressions, acceptances, additional revenue) [LF shows Bundles/Order bumps/One click upsells by count and total].

## 11. Payments and Currencies

**Scope boundary:** In scope: the unified interface (11.1) + a `sandbox` adapter, the gateways screen, wiring the existing Paymob into the store, manual transfer with a receipt image (11.3), payment rules (11.4), the currency code (11.5) using rates from a `sandbox` adapter, and the tokenization interface (11.6). Out of scope: writing any new gateway from table 11.2, and the currency rate provider. The table is a reference for the integrations team.

EasyOrders has 20 payment methods (Egypt and the Gulf), and Lightfunnels has global gateways + automatic currency conversion. ZIMOS has COD and Paymob (backend only) and a ready adapter interface in `payments/providers/`.

### 11.1 The adapter interface

The current interface has 4 methods (initialize, capture, refund, verifyWebhook). We add:

- `describe()` → `{ code, name, logo, countries[], currencies[], methods[] (card, wallet, bnpl, bank_transfer, apple_pay, google_pay), configFields[], supportsTokenization, supportsRefund, supportsTestMode }`. The UI renders the connection form from `configFields` instead of a dedicated screen per gateway.
- `validateCredentials(config)`.
- `tokenize` / `chargeSaved(token, amount)` for one-click upsell and subscriptions.

The connection for each store lives in `WorkspaceIntegration` (`provider = payment:<code>`), with secrets encrypted. The endpoints become generic: `GET ws/payments/gateways` (available gateways + connection status), `PUT/DELETE ws/payments/gateways/:code`, `PATCH ws/payments/gateways/:code/status` (enable/disable), replacing `ws/paymob/integration` (kept as an alias).

### 11.2 Gateways by priority

| Priority | Gateway | Market | Source | Notes |
| --- | --- | --- | --- | --- |
| P0 | COD | All | Existing | + optional extra fee (11.4) |
| P0 | Paymob (card, wallets, valU, Kiosk) | Egypt | Existing (backend) | Wire it into the store and the UI |
| P0 | Manual transfer with receipt image (InstaPay, Vodafone Cash, bank transfer) | Egypt | [EO] "Transfer image" | 11.3 |
| P1 | Kashier | Egypt | [EO] |  |
| P1 | Fawaterk | Egypt | [EO] [LF] | The merchant actually uses it in LF |
| P1 | Stripe (OAuth Connect, test mode, Apple/Google Pay, Klarna...) | Global | [EO] [LF] | Essential for digital products and subscriptions |
| P1 | PayPal (OAuth) | Global | [EO] [LF] |  |
| P1 | Tabby, Tamara (buy now, pay later in installments) | Gulf | [EO] |  |
| P1 | Moyasar, Tap, MyFatoorah, PayTabs, Paylink | Gulf | [EO] |  |
| P2 | Ziina, XPay, EasyKash, UPay, Fawry, FAB Misr | Various | [EO] |  |
| P2 | Checkout.com, Square, Razorpay, MercadoPago, CinetPay | Global | [LF] |  |
| P2 | Taager as a payment method | Egypt | [EO] | Tied to the Taager integration (section 16) |

Each gateway has, on the "Payment gateways" screen: the logo, the status (enabled/not enabled), an "Enable" button, an "Edit" button, and, if connected: the account name, Test mode, Disconnect, and the sub-methods as switches [LF]. A video tutorial for each gateway [EO].

### 11.3 Manual transfer with receipt image [EO]

- Setup: the method name (InstaPay, Vodafone Cash...), the instructions (wallet number or IPA), whether the image is required, whether the sender number is required.
- At checkout: the customer sees the instructions, uploads an image (same file-type validation as the existing media module, 5MB limit), and enters the sender's number/account. The order is created with `paymentMethod=bank_transfer` and `status=awaiting_payment`.
- The merchant reviews it from the order page: "Confirm transfer received" (→ `paid`, Payment captured with `providerCode=manual`) or "Reject".
- The same mechanism works **for deposits** [Z+]: the merchant can require prepayment of shipping from customers with a low delivery rate (section 5.4), with the remainder as COD.

### 11.4 Payment rules

- **Fees by payment method** [EO]: e.g., +10 SAR for COD, or a 5% discount for prepayment. `settings.payment_adjustments[] {method, type: fee|discount, valueType: fixed|percent, value, label}`. Shown as a separate line in the summary.
- **Gateways per funnel or store** [LF]: the merchant chooses which gateways appear in each funnel.
- **The pixel for online payment fires only after successful payment** [EO].
- **Failed attempts**: the order becomes `payment_failed` + a "Try again" link for the customer, and after one hour a WhatsApp message with the link (automation). Currently `failed` exists in the enum but nothing sets it.

### 11.5 Currencies

- **Account currency** (`defaultCurrency` exists): all analytics are displayed in it, and it cannot be changed after the first order [LF].
- **Currency per funnel or product** [LF] [EO]: the order is created in the funnel's currency and collected in it. `orders.currency` exists; we add `orders.fxRateToBase` and `totalAmountBase` for analytics.
- **Displayed currencies** [LF]: a list of additional currencies + "Automatically convert to the visitor's currency" + "Use all currencies" + currency format (symbol, its position, decimals, the new riyal symbol [EO]). Display in the converted currency is for display only; collection is in the funnel's currency unless the gateway supports the currency. A `currency_converter` element in the builder.
- `fx_rates` table (`base`, `quote`, `rate` with numeric(18,8) precision, `fetchedAt`) populated by a daily cron. The rate provider is an **open decision**. Conversion is done in `money.js` with defined rounding (half-up to the nearest minor unit).
- Analytics include a currency switcher (EGP / USD / MAD...) [LF].

### 11.6 One-click upsell and saved card

- `payment_methods_saved` (per customer, per gateway): `customerId`, `providerCode`, `token` (encrypted), `brand`, `last4`, `expiresAt`. Saving relies on the gateway's consent flow (we never store a card number).
- Used in upsell (section 9.5) and subscription renewals (section 18). If the gateway does not support tokenization, the upsell opens a condensed payment page.

## 12. Shipping

**Scope boundary:** In scope: city pricing (12.1), the `CarrierAdapter` framework and its tables and moving the existing Bosta behind it (12.2) + a `sandbox` adapter, bulk shipping, printing and the manifest (12.4), the screen (12.5), and manual export/import of waybill numbers. Out of scope: all companies in 12.3 and communicating with them (the integrations team).

EasyOrders is integrated with about 40 shipping companies in Egypt alone, while ZIMOS is integrated with Bosta only (backend). This gap is the biggest reason a COD merchant would not move to ZIMOS, so we must build a framework that makes adding a new company two days of work, not a week.

### 12.1 Shipping pricing [EO] [LF]

- **Pricing method**: "Flat rate" or "Rate per city/governorate". Shipping country (Egypt, Saudi Arabia, Algeria, Morocco, Palestine, Libya...). [EO]
- **Cities table**: city name, shipping price, type (base from the platform or custom from the merchant), status (visible/hidden), edit. Buttons: "Add city", "Edit price for all cities", CSV import [LF]. Example from your account: Cairo and Giza 90, the rest 130. [EO]
- **Areas under the city** (district), optional, with a different price [LF "Advanced shipping regions"].
- **Shipping options** (new in EO): more than one option for the customer (standard, express, branch pickup) with different prices and durations.
- **Shipping groups** [LF]: a set of prices linked to specific products (a heavy product at a higher price).
- **Implementation in ZIMOS**: `ShippingZone` + `ShippingRate` exist (flat, by weight, by quantity, by order value, free). Required:
  1. A seed for each supported country: Egypt's 27 governorates (with "North Coast" like EO) and their areas, and Saudi Arabia's regions. `geo_regions` table (platform): `country`, `code`, `nameAr`, `nameEn`, `parentCode`, `level` (governorate, city, district).
  2. A simple screen on top of Zones/Rates: a table of governorates with a price for each (each governorate = a zone with a flat rate under the hood), and the current advanced screen remains for power users.
  3. `shipping_profiles` for the groups + `products.shippingProfileId`.
  4. `GET /store/:ws/shipping/quote` exists; the store uses it instead of the mock `estimateShipping`.
- Setting "Disable automatic selection of shipping areas" (section 8.8).

### 12.2 Shipping carriers framework

The `src/modules/shipping/carriers/` folder contains `bostaCarrier.js`. We create a unified `CarrierAdapter` interface and rewrite Bosta on top of it:

| Method | Purpose |
| --- | --- |
| `describe()` | Code, name, logo, countries, `configFields`, capabilities (webhook, polling, cancel, label, cod) |
| `validateCredentials(config)` | Check the key before saving |
| `listCities()` / `listDistricts(cityId)` | The carrier's city codes (exist in Bosta) |
| `createShipment(order, options)` | Returns `{ waybillNumber, trackingUrl, labelUrl?, raw }` |
| `cancelShipment(shipment)` | Cancel before pickup |
| `getStatus(shipment)` | For polling |
| `parseWebhook(req)` | Verifies and returns `{ waybillNumber, carrierStatusCode, occurredAt }` |
| `mapStatus(code)` | To the unified `Shipment.status` (like `STATE_CODE_TO_STATUS` in Bosta) |
| `getLabel(shipment)` | The waybill PDF from the carrier if available, otherwise the ZIMOS waybill |

- **Carrier accounts**: each store can have multiple carriers in `WorkspaceIntegration` (`provider = carrier:<code>`), one of them the default. Settings for each account: `autoCreateShipmentOn` (`never`, `confirmed`, `paid`) [exists in the mock type], the pickup address, allowing inspection before acceptance, default notes for the courier.
- **City mapping**: `carrier_region_map` table (`carrierCode`, `geoRegionCode`, `carrierCityId`, `carrierDistrictId`), populated automatically by name matching and editable manually. If the order's city has no mapping, the order page asks the merchant to choose "City and area" before sending [EO].
- **Sync**: webhook if the carrier supports it (`POST /api/v1/webhooks/carriers/:code/:workspaceId`), otherwise the `carriers.poll_status` cron. Any change calls the existing `updateShipment`, which updates `fulfillmentState` and `status` (section 4) and emits `shipment.status_changed`.
- **Shipment log**: `shipment_events` table (`shipmentId`, `carrierStatusCode`, `status`, `description`, `occurredAt`) for the timeline.
- **Collection**: `codAmount` is sent with the shipment = the remaining balance on the order (after the deposit, if any). Settlements exist in `settlements` (section 15.5).

### 12.3 Carriers by priority

Priority is based on the EO merchant poll (Aramex 46%, Bosta 42%, J&T 23%, Turbo 20%, DHL 18%, Mylerz 14%) and on their enabled list:

1. **P0**: Bosta (existing, move it into the framework), J&T Express, Aramex, Mylerz, Turbo.
2. **P1**: Flash Express, Speedaf, Arrive, R2S/Red Express, Wingezz, Quick Connect, Hashtag Express, Aman, Shop Ship.
3. **P2 (the rest of EO's Egypt list)**: RM Express, Arco, Enjad, Alexander, 2go, QP Express, Tala Express, Future Shipping, Quicks, Reach Shipping Services, Flottex, Best Services, Ar Supply, Roc Express, Telegraph, Pro Zone, 4 Speed, Aldahab Express, 3al Sare3, Circle, WaveX, Eissa Express, Quick & Faster, Turbo Libya, Al Qemma Al Emaratiya.
4. **Gulf (P1 when we enter Saudi Arabia)**: SMSA, Aramex KSA, J&T KSA, Naqel. **Unverified** that they are in EO's list.

For each carrier before implementation: obtain the API documentation and a test account (**requires the project owner to contact each carrier**). A carrier without an API remains "manual": the merchant exports an Excel file in the format the carrier requires and brings back the waybill numbers via `import-tracking` (section 4).

### 12.4 Shipping from the dashboard

- From the order page: the shipping card (section 4.4).
- From the list: "Ship selected" → a dialog showing the carrier, the number of ready orders, and those missing a city mapping (fixed from the same dialog) → a job in the `carriers` queue → a success/failure report per order.
- "Resend to the shipping carrier" for those that failed. [EO]
- **Bulk waybill printing**: a single A4 PDF (four waybills per page) or thermal 10×15 cm. The existing `waybillService` is extended to an array of orders.
- **Manifest** (handover sheet for the courier): the list of waybills handed over today with collection amounts [Z+].

### 12.5 The screen (`ShippingTaxPage.tsx` and `CarriersSection.tsx`)

Tabs [EO]: "Integration with shipping carriers" (search by name, filter by country, a card for each carrier with its logo and a connect button), "Independent shipping" (prices without a carrier), "Shipping options", and the existing "Taxes" tab. `CarriersSection.tsx` is taken off the mock and calls `GET ws/shipping/carriers` (the catalog from `describe()`) and `GET/PUT/DELETE ws/shipping/carrier-accounts/:code`.

## 13. Tracking and Pixels

**Scope boundary:** In scope: the browser pixel, the `tracking_pixels` table, events and deduplication, UTM, the Purchase timing setting, the event log, the screen, and using the existing `pixelProviders` from the queue. Out of scope: any new server provider (Pinterest, Google Ads), and Clarity.

An advertising merchant chooses the platform that sends clean, non-duplicated events. ZIMOS sends Purchase from the server only (`marketing/pixelProviders/*`), and there is no browser pixel at all.

### 13.1 Platforms

| Platform | Browser | Server | Source |
| --- | --- | --- | --- |
| Meta (Facebook/Instagram) | Pixel, multiple IDs (one per line) | Conversions API (multiple pixels + token + note + test event code) | [EO] [LF] |
| TikTok | Pixel | Events API | [EO] [LF] |
| Snapchat | Pixel | Conversions API | [EO] [LF] |
| Google | gtag (GA4 + Google Ads conversion label) | GA4 Measurement Protocol (existing) | [EO] [LF] |
| Google Tag Manager | The container + dataLayer | — | [EO] [LF] |
| Pinterest | Tag | Conversions API | [LF] — P2 |
| Microsoft Clarity | Script with the Project ID (session recordings and heatmap) | — | [LF] |

**Data**: the existing `settings.tracking_pixels` accepts one ID per platform. It is replaced by a `tracking_pixels` table: `id`, `workspace_id`, `platform`, `pixelId`, `label`, `capiEnabled`, `capiTokenSealed`, `testEventCode`, `scope` (`all` or a list of `funnelIds[]`/`productIds[]`), `isActive`. [LF: choose the pixel per funnel, EO: product-specific pixel]

### 13.2 Events

| Internal event | Meta | TikTok | GA4/GTM | When |
| --- | --- | --- | --- | --- |
| `page_view` | PageView | Pageview | page_view | Every page |
| `view_content` | ViewContent | ViewContent | view_content | Product page |
| `add_to_cart` | AddToCart | AddToCart | add_to_cart | Add to cart or select a bundle |
| `begin_checkout` | InitiateCheckout | InitiateCheckout | begin_checkout | First interaction with the purchase form |
| `add_payment_info` | AddPaymentInfo | AddPaymentInfo | add_payment_info | Selecting an online payment method |
| `purchase` | Purchase | CompletePayment | purchase | Order created (or payment succeeded) |
| `lead` | Lead | SubmitForm | generate_lead | Squeeze form |

- The store sends the event to the browser **and** to `POST /store/:ws/events` (existing, accepts the first five; we add `add_payment_info` and `lead`). The server records it in `analytics_events` and enqueues a job in the `pixels` queue.
- **Deduplication**: the same `event_id` in the browser and the server. For Purchase = `order.id` (existing), and for the rest a UUID generated in the browser and sent with the event. Purchase is not sent twice if the customer refreshes the thank-you page (a flag on the order, `purchaseEventSentAt`). If there is more than one Meta pixel, the event is sent to each one with the same event_id [EO].
- **Matching data for the server** (hashed with SHA-256 per each platform's specification): mobile (E.164), email, first and last name, city, country, `external_id` (hash of customerId), and unhashed: `fbp`, `fbc`, `ttp`, `ttclid`, IP, user agent, page URL.
- **Value**: `value` = the actual order total in its currency, `content_ids` = the variant IDs (the same ones as in the Product Feed), `num_items`. The "different price for the pixel" feature in EO will not be built (section 21).

### 13.3 When to send Purchase (setting) [Z+]

`settings.purchase_event_timing`: `on_order` (the default, like everyone else), `on_confirmed` (only after the order is confirmed), `on_delivered`. The latter two options send from the server only (CAPI) with the real `event_time` and `action_source=system_generated` if the allowed time window has passed. The idea is that ads learn from real orders only. EO does something similar: orders that did not pass the OTP are not sent to the pixel. **Note**: the acceptance window for late events differs per platform; it must be checked against their documentation at implementation time.

### 13.4 UTM and traffic source

- The store saves in a cookie (30 days): `utm_*`, `fbclid`, `ttclid`, `gclid`, `ScCid`, `ref`, `referrer`, `landing_page`. Both **first touch** and **last touch**.
- They are sent with the checkout and stored in `orders.attribution` (section 4.2), and Sales Attribution reports are built from them (section 15).
- EO's `metadata.tracking` (first visit, number of sessions, pages, duration) = `orders.sessionStats` from the existing `analytics_sessions`.

### 13.5 The screen (`MarketingPage.tsx` → "Tracking tools")

- The list of pixels with platform + ID + label + CAPI status + scope, and an "Add pixel" dialog (type, Pixel ID, Token, Note, Test code) [EO].
- A persistent warning message: "If you don't understand CAPI, don't turn it on, because it can create duplicate events if the pixel is connected somewhere else" [EO].
- **Event log** [Z+]: the last 500 events sent from the server with their status (success/failure + error message), and a "Send test event" button. `pixel_event_logs` table.
- GTM tab (container ID), Google tab (GA4 ID, Ads conversion ID + label), Clarity tab.
- Setting 13.3.

## 14. WhatsApp, Notifications and Emails

**Scope boundary:** In scope: the step-based automation engine and ready-made templates, WhatsApp button confirmation on the existing webhook, the inbox, campaigns, email templates, merchant notifications, the tracking page. All of them run on the existing channels (Cloud API, Twilio, Brevo) or on the existing `console` channel, which logs to `notification_logs`. Out of scope: Embedded Signup, the shared ZIMOS number, a new SMS provider, email sending-domain verification, and push via FCM/APNs.

The backend has the official WhatsApp integration (Cloud API, signed webhook, conversations, messages) and an automations engine that sends a single template on 7 events. All the frontends run on the mock.

### 14.1 Channels

| Channel | Status in ZIMOS | Required |
| --- | --- | --- |
| Official WhatsApp on the merchant's number | Backend (manual connection via phone number id + token) | **Embedded Signup** from Meta (the merchant connects without copying tokens), syncing templates and their status, the UI |
| Official WhatsApp on the shared ZIMOS number [EO] | Missing | For a merchant without a verified Meta account: order messages go out from the ZIMOS number under the store's name. The cost is deducted from the wallet |
| SMS | Twilio for OTP only | SMS for orders as well + a cheaper Egyptian provider (**open decision**). EO charges one cent per message |
| Email | Brevo for auth and invitations only | Order emails + the merchant's sending domain (14.5) |
| Push for the merchant | Missing | Web + the mobile app (14.6) |

Unofficial QR-based WhatsApp (which EO calls "WhatsApp v2" and "Whatsapp Marketing") **will not be built** (section 21).

### 14.2 Automation (extending `automations`)

**Triggers** (the existing 7, then the new ones): `order.created`, `order.confirmed`, `order.rejected`, `order.cancelled`, `order.shipped`, `order.out_for_delivery`, `order.delivered` + `order.unreachable`, `order.postponed`, `order.returned`, `order.payment_failed`, `checkout.abandoned`, `lost_order.created`, `review.request` (N days after delivery), `lead.created`, `subscription.renewal_failed`.

**Conditions** (existing: `paymentMethod` and `minTotalAmount`): + `productIds[]`, `governorates[]`, `source` (store/funnel), `funnelIds[]`, `riskLevel`, `isFirstOrder`, `tags`.

**Steps** (existing: 1-5 actions of a single type): become an ordered sequence, each step being one of:

- `wait` (minutes/hours/days), `whatsapp_template`, `sms`, `email`, `webhook`, `add_tag`, `set_status` (e.g. to `confirmed` when the customer replies "Yes"), `notify_team`.
- Exit condition: the sequence stops if the status changes (e.g. the customer purchased after an abandoned cart).
- Execution happens in the worker (`automations.delayed`), and every step is recorded in `automation_runs` (existing) with its status.

**Variables** (existing: `customer_name`, `order_number`, `order_total`, `store_name`, `tracking_url`, `city`) + `product_names`, `items_count`, `shipping_amount`, `carrier_name`, `waybill_number`, `order_link`, `recovery_link`, `coupon_code`, `review_link`, `payment_link`.

**Screen** (`AutomationsPage.tsx`): list of rules with an on/off switch, statistics (sent, skipped, failed, last run — available in the API), a vertical step editor, a run log with a filter. **Ready-made Arabic templates** enabled with one click:

1. Order confirmation immediately on creation, with quick-reply buttons "Confirm order" and "Cancel". The customer's reply arrives on the existing webhook and **changes the status automatically** (`confirmed` or `cancelled`) and closes the confirmation task [Z+, this replaces the call center for most orders]. If there is no reply within X hours, it goes to the manual confirmation queue.
2. Shipped + waybill number and tracking link.
3. Courier on the way ("Have the amount ready").
4. Delivered + review request after 3 days.
5. Abandoned cart recovery (section 6.4).
6. Payment failed + payment link.
7. Did not answer the call → message "We tried to reach you".

### 14.3 WhatsApp Inbox (`InboxPage.tsx`)

- Connect to the existing routes (`GET /whatsapp/conversations`, `.../messages`, `POST /whatsapp/messages`, `PATCH` status open/closed). The mock uses the statuses `open|bot|resolved`, which is wrong.
- Real-time updates: SSE or WebSocket for new messages (from the worker via Redis pub/sub).
- Conversation sidebar: customer details, delivery rate, their latest orders with status, buttons "Confirm order", "Cancel" and "Create order".
- Saved quick replies (`whatsapp_quick_replies`), assigning a conversation to a staff member, filters (open, closed, assigned to me, unread).
- The 24-hour window: after it, replies are template-only (Meta rule), and the UI makes this clear.
- The bot (`WaBotPage.tsx`) → section 19.

### 14.4 WhatsApp Campaigns (Broadcast) [EO]

- Audience: a segment (section 18) or an Excel upload (name, number) — **only those with `marketingConsent`**.
- An approved marketing template, variables, scheduling, a daily cap (to protect number quality), automatic pause if the number's rating drops.
- The word "Cancel" or "STOP" removes consent automatically.
- Report: sent, delivered, read, replies, resulting orders (via the campaign's coupon or UTM).

### 14.5 Order Emails [LF Lightmail / Order Email Updates]

- Templates: order confirmation, shipping, cancellation, refund, abandoned cart, digital product delivery. A simple editor (subject + content + variables + store logo and color), preview, and send test.
- Sender: by default from the ZIMOS domain under the store's name, or the merchant's domain after adding SPF/DKIM (the screen shows the records and a "Verify" button). The "From" email for customers is in settings [LF "Customers From Email"].
- Email matters less in the Egyptian COD market (most orders have no email), so it is **P1** after WhatsApp.

### 14.6 Merchant Notifications

- A `notifications` table (`workspace_id`, `user_id` or null for everyone, `type`, `title`, `body`, `link`, `readAt`). Types: new order, suspicious order, low stock, integration failed (gateway, shipping, WhatsApp), export ready, wallet running low, platform announcements (from the existing `Announcement`).
- `NotificationsDrawer.tsx` is taken off the mock: `GET ws/notifications`, `POST .../read-all`.
- **A sound for new orders** in the dashboard and the app (optional) [EO].
- Per-user "Order notifications" settings [EO]: which types on which channel (in-dashboard, web push, app, email, WhatsApp to the merchant).

### 14.7 Customer Order Tracking Page

`/store/[ws]/track` exists on the mock; connect it to `GET /store/:ws/orders/track` (existing). It shows: the stages (confirmed, shipped, on the way, delivered), the shipping carrier and waybill number, public notes from the merchant, a "Copy tracking link" button [EO]. Access is by order number + the last 4 digits of the mobile number, or via a signed link from the message.

## 15. Analytics and Profits

This is where ZIMOS can beat both: EO shows a simple "net profit" (sales minus cost), and LF has no net profit at all. The backend has events, sessions and web stats, but the storefront does not send events and the frontends are mock.

### 15.1 Main Dashboard (`DashboardHomePage.tsx`)

KPI cards, each with the value + percentage change versus the previous period + a sparkline, plus a date filter (default: last 7 days), a store/funnel filter and a currency switcher:

| Metric | Definition | Source |
| --- | --- | --- |
| Visits | Number of sessions | [EO] [LF] |
| Orders | Excluding lost and test orders | [EO] [LF] |
| Average order value (AOV) | Sales ÷ orders | [EO] [LF] |
| Add-to-cart count | `add_to_cart` events | [EO] [LF] |
| Checkout starts | `begin_checkout` events | [EO] [LF "Reached checkout"] |
| Cross-sell additions | `add_to_cart` with `source=cross_sell` | [EO] |
| New orders | Not yet seen (`isSeen=false`) | [EO] |
| Lost orders | From section 6 | [EO] |
| Conversion rate | Orders ÷ visits | [EO] [LF] |
| Lost rate | Lost ÷ visits | [EO] |
| Total sales | Sum of `totalAmount` | [EO] [LF] |
| Net profit | From 15.4 (the estimated one, not just sales minus cost) | [EO] + [Z+] |
| Customers: new vs. returning |  | [LF] |
| Leads | From squeeze and newsletter forms | [LF] |
| Confirmation rate and delivery rate | confirmed ÷ orders, delivered ÷ shipped | [Z+] — the two most important numbers for a COD merchant |

Below the cards [LF]: the conversion funnel (visits → cart → checkout start → purchase, with percentages), an "Upsell & Offers" table (bundles, bumps, upsells: count and total), top traffic sources, top purchasing governorates/countries, devices, top products, top funnels. Plus educational cards (videos, Telegram, mobile app) [EO] + Setup Guide [LF].

The endpoint: `GET ws/analytics/overview?from&to&compare=previous&funnelId&currency` returns all metrics in a single request (the mock uses `/analytics/overview?range=`). Computation comes from daily aggregate tables `analytics_daily` (workspace, day, funnel, metrics) updated by the worker, not a query on raw events every time.

### 15.2 Live View [LF]

Today's visitors, today's orders, today's sales, a "page views per minute" chart for the last 10 minutes, and a live activity feed (checking out now, purchased), a funnel/store filter, and a full-screen button. `GET ws/analytics/web/realtime` exists; we add SSE updates.

### 15.3 Sales Attribution [LF]

Filter by UTM and by funnel, two charts (visitors and sales per day), and a table by source/medium/campaign/content: visitors, orders, sales, conversion rate, AOV. + [Z+] a "Delivered" column (sales of orders that were actually delivered) and a spend column and ROAS if ads are connected (15.4).

### 15.4 Real Profits [Z+] (the feature nobody else has)

**Scope boundary:** In scope: `product_economics`, `ad_spend_daily`, the profit report, and the campaigns screen, with **spend entered manually or via CSV** (date, platform, campaign name, spend) so the report works without an integration. Out of scope: OAuth with ad platforms and automatic spend pulling (the cron `ads.sync_spend` is built empty on a `sandbox` adapter).

The screens exist as mock (`ProfitPage.tsx`, `AdsPage.tsx`) and the types are in `types2.ts` (`ProductEconomics`, `PnlReport`, `AdAccount`, `Campaign`).

**Product economics** (`product_economics`, per product): unit cost (from `variant.costAmount`), packaging, collection fee percentage, gateway fee percentage, actual shipping cost (not what was collected from the customer), return cost (return shipping), damage percentage.

**Ads integration** (new `ads` module):

- OAuth with Meta Marketing API, TikTok Marketing API, Snapchat Marketing API. The merchant selects the ad accounts.
- cron `ads.sync_spend` pulls hourly: spend, impressions, clicks per campaign/adset/ad per day into `ad_spend_daily`.
- Matching with orders: `utm_campaign` = campaign name or ID, or `ad_id` from the URL parameters (we suggest ready-made URL parameters for the merchant to put in the ads manager).
- The screen: campaigns with spend, orders, confirmed, delivered, real CPA (spend ÷ delivered), real ROAS. Pausing/resuming a campaign and editing the budget from ZIMOS (present in the mock) is **P2**.

**Profit report** (`GET ws/analytics/pnl?from&to&groupBy=day|product|campaign`):

```
Delivered revenue
- Cost of goods for delivered
- Actual (outbound) shipping for all shipped
- Return shipping
- Collection and gateway fees
- Ad spend
- ZIMOS fees
= Net profit
```

- Two versions: **actual** (finished orders: delivered or returned) and **projected** (open orders × the store's historical delivery rate).
- The result per day, per product and per campaign, with profit margin and "maximum affordable CPA" per product (the point beyond which the campaign loses money).

### 15.5 COD Settlements (`SettlementsPage.tsx`)

The backend exists (`settlements`: draft → confirmed, a line per order, confirming the settlement creates a Payment). The screen connects to it with the real statuses (the mock has expected/received/discrepancy/reconciled, which is wrong). Additions: import the settlement statement Excel from the shipping carrier and match it to waybills automatically, highlight discrepancies (missing amount, waybill not found), and a summary of "money held by shipping carriers not yet received" [Z+].

### 15.6 Visitor Session Recording [LF]

Integrate Microsoft Clarity via Project ID (section 13). Building our own session recording is not required.

## 16. Integrations and API

**Scope boundary:** In scope (these are platform features, not third-party integrations): merchant Webhooks (16.1), Public API and keys (16.2), the app install link (16.3), the app store (16.6), and the `DropshipProvider` interface + `sandbox` adapter. Out of scope: everything in 16.4 and 16.5 (Google Sheets, Shopify, WooCommerce, Taager and the platforms, AliExpress, Mailchimp, Clarity, MCP, Top Media Buyers).

Integrations are what make a merchant stay: Google Sheets for the confirmation team, webhooks for external software, and connecting to dropshipping companies. In ZIMOS, `ApiKey`, `WebhookEndpoint` and `WebhookDelivery` exist as models without routes, and the permissions `api_keys.manage` and `webhooks.manage` are defined but unused.

### 16.1 Merchant Webhooks [EO] [LF]

- **Topics** (union of both): `order.created`, `order.updated`, `order.status_changed` (with `old_status` and `new_status` like EO), `order.confirmed`, `order.fulfilled`, `order.cancelled`, `order.uncancelled`, `order.refunded`, `order.paid`, `checkout.created`, `checkout.updated`, `checkout.abandoned`, `customer.created`, `lead.created`, `contact_form.submitted`, `product.created`, `product.updated`, `product.deleted`, `funnel.published`, `shipment.status_changed`.
- **Configuration**: the URL, the topics, an auto-generated secret (`signingSecret` exists), an optional filter (funnel or product).
- **Signature**: header `X-Zimos-Signature: t=<timestamp>,v1=<HMAC-SHA256(secret, timestamp + "." + body)>` + `X-Zimos-Event` + `X-Zimos-Delivery-Id`. Documentation includes a verification example in Node and PHP.
- **Delivery**: queue `webhooks`, 10-second timeout, success = 2xx, retries per the schedule in 3.1, and after 3 days of continuous failure the endpoint is disabled and the merchant is notified.
- **Delivery log** [LF]: All / Succeeded / Failed, date, event, URL, response code, and a **Resend** button. From the existing `webhook_deliveries`.
- "Resend order to webhook" from the order page and from bulk actions [EO].
- Routes: `GET/POST/PATCH/DELETE ws/webhooks`, `GET ws/webhooks/deliveries`, `POST ws/webhooks/deliveries/:id/resend`, `POST ws/webhooks/:id/test`.

### 16.2 Public API [EO] [LF]

- **Keys**: a "Public API" screen in settings: name, permissions (scopes), the key is shown only once, last used, revoke. `ApiKey` exists (hash + prefix + scopes + `rateLimitPerMinute=60`).
- **Scopes**: `products:read|create|update|delete`, `orders:read|create|update|delete`, `categories:read|create|update|delete`, `customers:read`, `discounts:read|write`, `shipping_areas:read|write`, `webhooks:write`, `analytics:read` [EO for the first four, LF for the rest].
- **Authentication**: header `Authorization: Bearer zk_live_...` (or `Api-Key` for compatibility with people coming from EO). A new middleware `authenticateApiKey` sets `req.tenant` in the same shape as `resolveTenant` so the services work as they are.
- **Path**: `/api/public/v1/...`, the same services but separate controllers with a fixed (versioned) response shape.
- **Endpoints**:
  - Orders: list (filters: status, created_from/to, updated_since, product_id), get by id, get by number, create, update status, add note, add tracking.
  - Products: list, get, create, update, delete, `PATCH /products/sku/:sku/stock` [EO].
  - Categories: CRUD.
  - Customers: list, get.
  - Shipping areas: list, bulk `PATCH` of city prices [EO].
  - Discounts: CRUD.
  - Webhooks: CRUD.
- **Limits**: 60 requests per minute per key (EO: 40), with headers `X-RateLimit-Limit/Remaining/Reset` and `429`.
- **Documentation**: a separate OpenAPI for the public API (`docs/openapi.json` exists for the internal one) + a public docs page.

### 16.3 App Install Link (for companies building on ZIMOS) [EO]

`https://app.zimos.co/install-app?app_name&app_description&app_icon&callback_url&orders_webhook&order_status_webhook&permissions&redirect_url`: the merchant approves → ZIMOS creates a key with the permissions and sends it to `callback_url` (POST with `api_key` and `store_id`), registers the webhooks automatically, and returns the merchant to `redirect_url`. This is the easiest way for dropshipping and confirmation companies to integrate with us. **P1**. A full OAuth app system like LF (partners portal, iframe apps, app charges) is **P2**.

### 16.4 Google Sheets [EO] [LF]

- Google OAuth (scope limited to files the merchant selects, `drive.file`), select or create a sheet.
- Multiple connections per store [EO]: each connection = a sheet + data type (orders, lost, leads) + a filter (specific products or specific funnels) + the columns (selection and ordering, and custom columns mapped to form fields) [LF].
- Option "Group products into one row by order number" [LF].
- Real-time sync from the worker: new order = new row, status change = update the status column in the same row (we store the row number in `sheet_row_refs`). With retries and an alert if the permission is revoked (EO has had complaints about lost orders).
- A "Sync existing" button for the first time (last 30 days).

### 16.5 Other Platforms

| Integration | What it does | Source | Priority |
| --- | --- | --- | --- |
| Shopify | Connect via custom app token, import products, push ZIMOS orders to Shopify (for people who use Shopify for fulfillment), inventory sync | [EO] [LF] | P1 |
| WooCommerce / WordPress | REST keys, import products, receive orders | [EO] | P2 |
| Taager | API key, their product and variant code, automatic order forwarding to them, option "Use their shipping rates", reject the order if below their minimum | [EO] | P1 |
| Anjezni, We Sell, Remonda, Acomeo, Mosawq... | Same idea (import products, forward orders) | [EO] | P2 |
| AliExpress and CJ | Import products + order from the supplier (Business account, OAuth) | [LF] | P2 |
| Mailchimp / Klaviyo | Sync contacts and segments | [LF] | P2 |
| Microsoft Clarity | Project ID | [LF] | P1 (easy) |
| Zimos MCP server | The merchant manages their store from an external AI assistant on top of the Public API | [LF] | P2 |
| Zapier / Make / n8n | Via webhooks + API key | [Z+] | P2 |
| Top Media Buyers | Verifying the marketer's order count | [EO] | Optional |

The shared framework for dropshipping companies: `DropshipProvider` adapter (`importProduct(code)`, `pushOrder(order)`, `syncStock()`, `mapStatus()`) + `products.externalRefs` (section 7.1).

### 16.6 App Store (`AppsPage.tsx`)

The screen in the style of EO and LF: an "Installed" tab and a "Discover" tab, categories (tracking, sales optimization, dropshipping, order management, protection, SEO, marketing, store management), search, a card per app (name, description, price or "Free", install/open/uninstall). In ZIMOS, an "app" here can be either an internal feature that gets enabled (e.g. sales notification) or an external integration. An `apps` table (platform-level: `key`, `category`, `priceAmount`, `billing` once/monthly, `kind` feature/integration) and `workspace_apps` (`status`, `installedAt`, `renewsAt`). Features that have an app check `workspace_apps` before running.

## 17. Team, Settings and Account

### 17.1 Team and Permissions

ZIMOS has the strongest permission system of the three (30 permissions + 6 ready-made roles + custom roles). What is missing is a simpler UI:

- Team screen [LF]: members split into "Admins" and "Members", a "5 of 14" counter based on the plan, invite by email.
- Invite dialog: "Admin" (everything) or "Partial permissions" with checkboxes for understandable sections [LF: Home, Orders, Products, Analytics, Contacts, Discounts, Settings, Form data, Funnels, Stores, Apps (all or specific)] [EO: Statistics, Products, Categories, Reviews, Cross-sell, Coupons, Google Merchant, Webhooks, WhatsApp, Order notifications, Invoices, Apps]. Each checkbox maps to a group of the 30 permissions (the mapping table is in `permissions.js`), and an "Advanced" button opens the 30 permissions themselves.
- We add ready-made roles: `fulfillment` (shipping and printing only) [mentioned in BACKEND_CONTRACT].
- The moderators license in EO is a paid app; ours is free within the plan limit.

### 17.2 Security and Sessions

- **Login sessions** [EO]: device, browser, IP, last activity, "End" and "End all" buttons. The API exists (`GET /auth/sessions`, `POST /auth/sessions/revoke-all`); what is missing is the screen and ending a single session.
- **Two-factor verification** [EO]: a WhatsApp or email code when logging in from a new device, + optional TOTP (Google Authenticator) [Z+]. Builds on `otpService`.
- **Merchant phone number** [EO]: confirmation via OTP (the API exists: `verify-phone`).
- **Support access** [LF]: the merchant allows the ZIMOS team temporary access (for a set duration) and can revoke it at any time. Without this permission, a platform admin cannot open the store's data (impersonation is recorded in audit).
- **Activity log** [Z+]: a screen on top of the existing `GET ws/audit-logs` (who did what and when).

### 17.3 Domains, Policies, Files

- Domains: section 8.11. Policies: section 8.3. Store details: section 8.5.
- **File library** [LF "Digital Products / Files"]: upload files for digital products (section 18.2), limit based on the plan. The existing media is for images only (5MB).
- **Account settings** [LF]: account name, picture, owner email, email for receiving contact forms, the subdomain, the legal address (name, company, phone, address, country) for invoices, the time zone.

### 17.4 ZIMOS Plans and Billing (**on hold until pricing is decided**)

Competitor pricing for reference:

|  | EasyOrders | Lightfunnels |
| --- | --- | --- |
| Model | Prepaid wallet + per-order fee, or subscription | Monthly subscription + percentage of sales |
| Basic | $0.04 per order | Newbie $9.99 + 1.5% + 0.2% on COD |
| Top | $100 per month with no order fees | Standard $49.99 (0.5% + 0.1%), COD $99.99 (0.5% + 0% on COD) |
| Limits | Unlimited | 1-3 stores, 1-3 domains, 1000-5000 leads/month, 14 members |

What exists in ZIMOS: `Plan` (monthly and yearly price, `softOrderQuota`, `transactionFeeBp`, `codFeeBp`, `features`), `Subscription`, `BillingInvoice`, and the gateway is not connected. Required after the project owner chooses the model:

1. **Forbidden for now**: the wallet and balance top-up, per-order fees, connecting a gateway for ZIMOS billing, any price hard-coded in the code, and any store lock due to balance. All of this is waiting on the pricing decision.
2. **Allowed because it will be needed under any model**:
   - A single middleware `requirePlanLimit(key)` that reads the limit from `Plan.features` (stores, domains, members, leads, file storage, `remove_branding`). If the key is not present in the plan, it is unlimited.
   - A `usage_counters` table (`workspace_id`, `period`, `orders`, `messages`, `ai_requests`, `storage_bytes`) updated by the worker, because any pricing will need counting.
   - Any feature that is "paid" at competitors is gated only by `FeatureFlag` or `Plan.features`, without the code knowing its price.
3. `PlanTab.tsx` is taken off the mock and displays what `GET ws/billing` (existing) returns as is, without payment or upgrade buttons.
4. The table above is a reference for the project owner when they decide; it is not required to be implemented.

### 17.5 Platform Admin Panel (`apps/platform-admin`)

The backend exists (plans, subscriptions, feature flags, announcements, users, stores, audit, system), and the UI uses only one endpoint. Required: connect all the screens, + new screens: wallets and transactions, theme and template catalog, app catalog, shipping carriers and city mapping, delivery network statistics (aggregated), the queues (Bull Board), support tickets (P2).

## 18. Additional Lightfunnels Features

These features serve sellers of digital products, courses, or subscriptions more than COD merchants, but they matter for ZIMOS to win the Lightfunnels segment (like your account that sells the "From Zero To Profit" course).

### 18.1 Subscriptions and Installments [LF] — P2

- Payment model on the product: one-time, subscription (weekly, monthly, yearly, with an optional trial period), installments (the price split into N payments).
- `customer_subscriptions` table: customer, product, status (`trialing`, `active`, `past_due`, `paused`, `cancelled`), current period, next renewal, saved payment method, number of remaining installments. Each renewal creates a new linked order.
- cron `subscriptions.renew`; if payment fails: retry after 1, then 3, then 7 days + a message to the customer with a link to update the card, then `cancelled`.
- "Subscriptions" screen [LF]: overview (revenue, total, new, active, latest, top products) + a list of all subscriptions.
- Customer portal: cancel or update the card via a signed link sent to them by email/WhatsApp.
- Conditional on a payment gateway that supports tokenization (Stripe, Paymob). Not available with COD.

### 18.2 Digital Products [EO] [LF] — P1

- Product type `digital` (exists in `productType`). Delivery via `digital_deliveries` per product: `type` (`file` from the file library, `link`, `license_codes` from a code inventory from which one code is drawn per order), delivery message, allowed number of downloads, link validity period.
- After payment (not after the order if COD): the order becomes `fulfilled` automatically [LF], and the customer gets a signed download link (R2 signed URL) on the thank-you page and by email and WhatsApp.
- "Digital product delivery settings" screen [EO]: delivery setup per product.
- File library [LF]: upload large files (limit per plan; LF says up to 10GB per file) via multipart upload directly to R2 (presigned).

### 18.3 Courses (LMS) [LF Lightskool] — P2

- `courses` → `course_modules` → `lessons` (video, text, files, duration), drip release (N days after purchase), free preview lesson.
- The digital product is linked to a course, and the purchase creates an `enrollment` and a student account (login via magic link or OTP).
- Student portal on the store domain: my courses, progress, lessons.
- Video from an external streaming provider with protection (Cloudflare Stream or Bunny) **open decision**.

### 18.4 Contacts and Segments [LF]

- The existing `Customer` becomes a "contact" with `type`: `customer` (has an order) or `lead` (subscriber only). + `tags[]` (`segments[]` exists; we unify them), `source`, `lastOrderAt`, `totalSpent`.
- **Tags from pages** [LF]: any submit or purchase button in the builder can add a tag to the customer (e.g. "interested-in-course").
- **Segments**: dynamic rules (include/exclude tags, number of orders, total spend, last order more than X days ago, governorate, bought a specific product, delivery rate, marketing consent) evaluated at time of use. `segments` table (`name`, `rules` jsonb). Used in WhatsApp campaigns (14.4) and syncing with email tools.
- **Form data** [LF "Contact Form Data"]: every submit from a `form` element is stored in `form_submissions` and emits `contact_form.submitted`, and it has its own screen and permission.
- Contacts screen: "All" and "Segments" tabs, search, filters, export, customer page (orders, tags, forms, conversations, delivery rate). The existing `CustomersPage.tsx` is extended.

### 18.5 Multiple Stores

- In LF, a single account has more than one store + funnels. In ZIMOS, a workspace = one store, and a user can be a member of more than one workspace. **Decision**: keep this model (simpler and safer), and add:
  - A store switcher in the header.
  - An "All my stores" screen (`StoresPage.tsx`) from `GET /me/stores/overview`: for each store, today's orders, sales, confirmation rate, balance, alerts.
  - "Duplicate store" (products + theme + settings, without orders and customers).
  - Move products between stores (JSON export/import, section 7.5).
- Funnels live inside the same workspace, on separate domains if the merchant wants.

### 18.6 General User Experience [LF]

- **Global search (⌘K / Ctrl+K)**: orders by number or mobile, products, customers, funnels, settings pages, and commands ("New product"). `GET ws/search?q=`.
- **Setup Guide** [LF] [EO]: a checklist with a completion percentage (add a product, connect a domain, enable a payment gateway or COD, connect a shipping company, connect a pixel, place a first test order). `OnboardingChecklist` exists; connect it to real data.
- **Shortcuts** [LF]: the merchant pins frequently used pages in the sidebar.
- **Education** [EO] [LF]: tutorial video links next to every important setting, a help center, a Telegram channel for updates, support chat.
- **Dashboard language** Arabic/English (exists) + dark mode [EO].

## 19. Artificial Intelligence

**Scope boundary:** In scope: `aiService` with a provider interface + a `sandbox` provider that returns fixed results matching the schema, the prompts, the queue, the usage counter, and the screens. Out of scope: choosing the provider and its key, and the bot on WhatsApp with a real number.

Both of them have AI that generates content and pages, and ZIMOS has nothing at all. The real feature is not a "write description" button, but that the merchant goes from a product photo to an ad-ready funnel in Egyptian Arabic in minutes.

### 19.1 Architecture

- An `ai` module with `aiService` and a provider abstraction (the model provider is an **open decision**). Every request returns JSON with a defined schema and is validated with Joi before saving.
- Execution happens in the `ai` queue, and the UI waits for the result (polling or SSE).
- Usage per store in `ai_usage` (type, tokens, cost), and a monthly limit per plan [LF says "unlimited, while preventing abusive use"].
- Prompts are stored in the code with versions (`prompts/product_description.v1.md`), and take the requested dialect (Egyptian, Gulf, Modern Standard Arabic, English, French).
- Any content produced by the AI goes to draft only, and the merchant is the one who publishes.

### 19.2 Features

| Feature | Inputs | Outputs | Source | Priority |
| --- | --- | --- | --- | --- |
| Create product with AI | Images + name or link + price | Name, description, features, FAQs, meta description, slug, "special offer" text | [EO "Create using AI"] [LF "AI Generate"] | P1 |
| Funnel/landing with AI | Product + audience + dialect + template | A full page tree (hero, problem/solution, features, guarantee, FAQs, CTA, COD form) using allowed elements only | [EO "AI funnel"] [LF "AI Template"] | P1 |
| Page evaluation | Page tree + its metrics | Score + recommendations (form is too far down, images are heavy, no guarantee) | [EO] | P2 |
| Translation | Any content | Text in the requested language | [LF] | P1 |
| Ad creatives | Product image | Banner images + ad copy in Arabic | [LF Pixelier] | P2 |
| Build a full store | Niche + name + color | Theme + home page + collections + policies | [LF "Start with AI"] | P2 |
| Store policies | Store data | Shipping, returns, and privacy policies | [Z+] | P1 |
| Suggested WhatsApp replies | Conversation + order | A suggested reply the employee sends with one click | [Z+] | P2 |
| Fake order screening | Name and address | Assessment | [EO Spam Shield] | P2 (section 5.5) |

### 19.3 Customer Service Assistant (the Bot) [EO "Shater"] — P2

- Replies to customers on WhatsApp (and store chat later) from product data, prices, stock, policies, and product FAQs; can look up order status by mobile number, **and can create a COD order** after confirming the details with the customer.
- Hands off to an employee if the question is outside its knowledge, or the customer asks for a human or is upset.
- Settings (`WaBotPage.tsx`): on/off, working hours, tone and dialect, additional information written by the merchant, limits (does not give discounts on its own).
- The conversation appears in the inbox with a "bot" badge, and an employee can take over the conversation at any time.
- Counter: number of monthly replies per plan (Shater sells packages from 1,000 to 25,000 replies).

What we will **not** build with AI: fake reviews (LF has "AI-Generated Reviews") — section 21.

## 20. Mobile App, Affiliates, and Services Marketplace

### 20.1 Merchant App [EO] — P1

EasyOrders has an Android and iOS app for merchants, and so does Lightfunnels. The Egyptian merchant follows their orders from mobile most of the time.

- **Technology**: React Native + Expo, a new app `apps/merchant-mobile` that uses the same `packages/api-client`. Push via Expo Notifications (FCM/APNs), and a `device_tokens` table (`userId`, `platform`, `token`, `lastSeenAt`).
- **Screens**:
  1. Login (email, Google, WhatsApp OTP) + store switcher.
  2. Home: today's KPIs (orders, sales, confirmed, abandoned) with a period filter that **remembers the last selection** [EO].
  3. Orders: tabs by status, search, filters, **delivery rate bar** in the list [EO].
  4. Order page: change status, call or WhatsApp the customer with one tap, **copy customer details with one tap** [EO], coupon used [EO], send to shipping company (list of companies), notes.
  5. Abandoned + converting to an order.
  6. Notifications.
- **New order notification** with an optional "cash" sound [EO], and its content (product + total + governorate).
- Faster first version: a PWA of the dashboard (manifest + web push) until the app is finished [Z+].

### 20.2 An App for the Store Itself [EO "SplendApp"] — P2

The store as an app for customers: start with a PWA for the store (home-screen icon, push notifications), and later an APK build service. EO does this through a partner.

### 20.3 Affiliates (Marketers Selling the Merchant's Products) [EO partially] [Z+] — P2

`AffiliatesPage.tsx` is mock. Required:

- `affiliates`: name, mobile, code (`ref`), commission type (percentage or fixed amount per order), value, allowed products, status.
- Commission is earned on the **delivered order** only (not confirmed), and is voided if it is returned. `affiliate_commissions` table (order, amount, status: pending, approved, paid, void).
- A simple portal for the marketer (OTP login): their links, their orders (without customer data), their balance, payouts.
- The merchant records "Paid" manually (Vodafone Cash/transfer).
- Referral links from section 10.8 feed this system.

### 20.4 ZIMOS's Own Referral Program [EO] — P2

The merchant shares a ZIMOS link with their code and gets a percentage of the subscriptions/shipping of the merchants they brought in (EO: 20% lifetime, cash). Screen: commission, link, sign-ups, withdrawal request. The percentage is an **open decision**.

### 20.5 Services Marketplace [EO] — P2

A directory of service providers for merchants, by category (page management, landing pages, UGC, video, marketing, programming, consulting, store setup, design, accounting), each service with price, rating, provider, and a contact button. Managed from platform-admin with a `service_listings` table. Payment between the merchant and the service provider is off-platform in the first phase. The same idea could include the "Suppliers marketplace" in the mock `SuppliersPage.tsx`.

## 21. Things We Will Not Build and Why

The implementing agent must not build anything from this table, even if it exists in a mock or in `BACKEND_CONTRACT.md`. Whatever of it exists in the UI is removed.

| Feature | Where it exists | Reason | ZIMOS alternative |
| --- | --- | --- | --- |
| Call center (agents, call logs, VoIP, settings) | ZIMOS mock, EasyConfirm | Excluded at the project owner's request | The existing confirmation list stays as is + automatic confirmation via WhatsApp (14.2) |
| Camouflage feature (Camouflage / cloaking) | EO ($10 per month), ZIMOS mock and BACKEND_CONTRACT 3.5 | It shows ad reviewers a different page from what the customer sees, which is explicitly prohibited by Meta and TikTok policies, gets merchants' accounts shut down, and could get all ZIMOS domains blacklisted | None |
| Fake visitor counter ("20 visitors viewing now") | EO | False information to the consumer. EO itself states "we do not recommend it" | A real viewer counter from Live analytics (optional) |
| Fake stock ("5 pieces left") | EO | Same reason | Show real stock when it falls below `lowStockThreshold` |
| Countdown timer that restarts (fake evergreen) | EO, LF (evergreen) | Fake urgency | A timer for an offer that actually ends, and the server reverts the price after it (per visitor or for everyone) |
| Different price sent to the pixel to "lower the CPA" | EO | Sends fake data to ad platforms, and ruins campaign optimization for the merchant themselves | Option "send Purchase after confirmation/delivery" (13.3) |
| AI-generated reviews | LF | Fake reviews with names of people who do not exist | Automatic review request after delivery + import of the merchant's real reviews (7.7) |
| Sales notification with made-up names or products | EO (the merchant writes the names) | Same reason | Notification from real orders only (10.7) |
| Unofficial WhatsApp via QR (WhatsApp Web session) | EO (WhatsApp v2, Whatsapp Marketing) | Violates WhatsApp's terms and exposes merchants' numbers to bans, and EO itself suspended OTP more than once because of it | Official WhatsApp with the merchant's number or ZIMOS's shared number (14.1) |
| WhatsApp campaigns to uploaded numbers without consent | EO | Spam and burns the numbers | Campaigns only to those with marketing consent (14.4) |

If the project owner decides to bring back any item, the decision is written here with the date before any work.

## 22. Phased Implementation Plan

Order matters: no new feature before what is already built works, and no phase starts before the previous one's Gate is met. Timelines are not set here and are determined by team size.

```
Phase 0: Foundation        -> Gate 1: zero mock pages
  (what's built works)
Phase 1: COD operations    -> Gate 2: 100 sandbox orders, created to delivered
  (on par with EasyOrders)
Phase 2: Conversion        -> Gate 3: full funnel with a working upsell
  (on par with Lightfunnels)
Phase 3: Leadership
  (stronger than both)
```

Phase 0 is the starting point, and each Gate between two phases is a condition that must be met before moving on.

### Phase 0: The Foundation (Making What Is Built Actually Work)

- [ ] Redis + BullMQ + `src/worker.js` + the outbox and the event catalog (3.1, 3.2)
- [ ] Core cron jobs: abandoned, trials, webhooks (3.3)
- [ ] The eight security fixes (3.4)
- [ ] CI + Sentry + logger (3.5)
- [ ] Wire up the pages that already have a ready backend: protection (5.7), automation (14.2), inbox (14.3), settlements (15.5), abandoned (6.3), checkout settings (8.6), plan (17.4), stores (18.5), notifications (14.6), platform-admin (17.5)
- [ ] Storefront: checkout sessions (6.2), analytics events, browser pixel with deduplication (13.2), reviews (7.7), real tracking and shipping estimates (14.7, 12.1), domains in `proxy.ts` (8.11)
- [ ] Paymob in the storefront and the UI (11.2)
- [ ] Order export (4.3)

**Gate 1**: `grep -r mockApi apps/merchant-dashboard/src/pages` returns only the pages whose feature belongs to a later phase (ads, profits, affiliates, suppliers, A/B) and which show a "Coming soon" badge, `mockCommerce.ts` has been deleted, and all tests pass in CI.

### Phase 1: COD Operations (On Par with EasyOrders)

- [ ] Statuses and transitions, new fields, the list, the order page, manual order, the API (all of section 4)
- [ ] Five-layer protection + OTP on existing channels + the delivery network table starts collecting from day one (section 5)
- [ ] Abandoned and recovery (section 6)
- [ ] Product fields and its page settings, variants, collections, Excel/JSON import, Product Feed (7.1 through 7.8)
- [ ] Themes, home builder, pages, UI Blocks, purchase form, thank-you page, SEO, domains per the scope boundary (section 8)
- [ ] Bundles, bump, cross-sell, exit downsell, coupons, free shipping, sales notification, referral links (10.1 through 10.9)
- [ ] Unified gateway interface + `sandbox` adapter + transfer with receipt image + payment rules (11.1, 11.3, 11.4)
- [ ] Shipping company framework + `sandbox` adapter + moving Bosta behind it + city pricing + bulk shipping and printing (12.1, 12.2, 12.4, 12.5)
- [ ] Multiple pixels + events + Purchase timing (section 13 per the scope boundary)
- [ ] Step-based automation, ready-made templates, button-based confirmation, and the inbox (14.2, 14.3)
- [ ] Webhooks + Public API (16.1, 16.2)
- [ ] Team, sessions, and two-factor authentication (17.1, 17.2) + plan limits without prices (17.4)
- [ ] Main dashboard with real metrics (15.1)

**Gate 2**: 100 test orders running from creation to delivery on the `sandbox` adapters (payment, shipping, messaging), with all statuses, events, webhooks, and analytics coming out correctly, and tests passing. The pilot with a real merchant starts when the integrations team connects the first shipping company.

### Phase 2: Conversion (On Par with Lightfunnels)

- [ ] Visual page editor, new elements, styles, responsive, smart sections, data binding (9.3, 9.4)
- [ ] Funnel creation, templates, and sharing, the map editor, display in the store (9.1, 9.2, 9.8)
- [ ] upsell, downsell, and bump with COD, and the tokenization interface on the `sandbox` adapter (9.5, 11.6)
- [ ] Split tests + product A/B (9.6)
- [ ] Funnel settings, country-based routing, languages (9.7, 8.10)
- [ ] Multi-currency code on `sandbox` rates (11.5)
- [ ] Funnel analytics + Live View + Sales Attribution (9.9, 15.2, 15.3)
- [ ] Contacts, segments, forms, and campaigns (18.4, 14.4)
- [ ] Order email templates on the existing Brevo (14.5) and digital products (18.2)
- [ ] AI P1 on the `sandbox` provider: product, funnel, translation, policies (section 19)
- [ ] ⌘K search, setup guide (18.6)

**Gate 3**: A complete funnel (article → product → checkout → upsell → downsell → thank-you) built from a template in under 15 minutes, the upsell adds to the same COD order, and the split test distributes visitors and picks a winner.

### Phase 3: Leadership (Stronger Than Both)

- [ ] Real profit report with manual or CSV ad spend (15.4)
- [ ] Merchant app (20.1); push waits on the integrations team
- [ ] Affiliates + ZIMOS referral program with the percentage from settings, not from code (20.3, 20.4)
- [ ] App install link and the app store (16.3, 16.6)
- [ ] Subscriptions and courses on `sandbox` adapters (18.1, 18.3)
- [ ] Customer service bot, creatives, AI store building on the `sandbox` provider (19.2, 19.3)
- [ ] Interactive catalog, web push screen, services marketplace (7.9, 10.10, 20.5)

### What Is Outside the Implementing Agent's Scope

**Project owner decisions** (the code does not wait on them, because each of these values is read from a setting):

| Decision | Section |
| --- | --- |
| ZIMOS pricing model, plans, and limits | 17.4 |
| The wallet and the negative balance policy | 17.4 |
| Prices of paid themes and apps | 8.1, 16.6 |
| ZIMOS referral program percentage | 20.4 |
| The aggregated delivery network data clause in the terms | 5.4 |

**Integrations team work** (each one builds on a unified interface that the implementing agent builds first):

| Integration | Section | Interface it builds on |
| --- | --- | --- |
| New payment gateways | 11.2 | payment adapter (11.1) |
| Shipping companies | 12.3 | `CarrierAdapter` (12.2) |
| Automatic SSL and domain purchasing | 8.11 | `certificateProvider` |
| IP reputation and IP country | 5.2 | `ipIntel` |
| Currency exchange rates | 11.5 | fx adapter |
| WhatsApp Embedded Signup and ZIMOS's shared number, new SMS, email domain, push FCM/APNs | 14.1, 14.5, 20.1 | existing notification providers |
| Pinterest and server-side Google Ads, Clarity | 13.1 | `pixelProviders` |
| Ad platforms (pulling spend) | 15.4 | ads adapter + `ad_spend_daily` |
| Google Sheets, Shopify, WooCommerce, Taager and the platforms, AliExpress, Mailchimp, MCP | 16.4, 16.5 | `DropshipProvider` + Webhooks + Public API |
| AI provider | 19.1 | `aiService` |
| Course video provider | 18.3 | video adapter |
| Importing products from non-Shopify links | 7.5 | import job in queue `io` |

### How to Work with Claude (Splitting into Chats)

The rule: **one chat = one small task = one branch = one PR**. Do not give one chat the whole document to build; a long chat forgets the rules and guesses.

**One-time setup:**

1. Put the document in both repos as `docs/SPEC.md`.
2. Create a `CLAUDE.md` at the root of each repo containing section 0 and section 1 in brief. Claude Code reads it automatically in every chat, so the rules will not get lost.
3. In the workspace itself, open both repos together for tasks that involve backend and frontend.

**Phase 0 chats in order:**

| # | Chat | Sections | Repo |
| --- | --- | --- | --- |
| 1 | Redis + worker + outbox + cron + migrating the old emits | 3.1, 3.2, 3.3 | Backend |
| 2 | Security fixes + logger + Sentry + CI | 3.4, 3.5 | Both |
| 3 | `api-client`: methods + types for all existing backend routes that have no client (fraud, automations, whatsapp, settlements, checkout-sessions, analytics, billing, paymob, bosta, server-pixels, audit) | 2 + the routes appendix | Frontend |
| 4 | Dashboard wiring A: protection, automation, inbox, settlements | 5.7, 14.2, 14.3, 15.5 | Frontend |
| 5 | Dashboard wiring B: abandoned, checkout settings, plan, all my stores, notifications | 6.3, 8.6, 17.4, 18.5, 14.6 | Both |
| 6 | Storefront: sessions, events, pixel, reviews, tracking, shipping estimate, domains, deleting `mockCommerce.ts` | 6.2, 13.2, 7.7, 14.7, 12.1, 8.11 | Frontend + part backend |
| 7 | Existing Paymob in the storefront + order export | 11, 4.3 | Both |
| 8 | platform-admin wiring | 17.5 | Frontend |

**After Phase 0**: each subsection (e.g. 4.1 + 4.2) that has backend and frontend is split into two chats: backend first (migration + service + routes + tests + methods in `api-client`), then frontend. A large section like 9.3 (the builder) is split further: the tree and validation, the canvas and the iframe, the element panel, new elements in batches, responsive, smart sections.

**Starter message for each chat** (change what is between the brackets):

```
Read docs/SPEC.md: section 0, section 1, and section [section number].
Task: [task description from the chats table].
Work on a branch named feat/[short-name].
Before any code: read the files mentioned in the section, write me a plan of 5-10 points, and wait for my approval.
Respect the scope boundary: any external integration = interface + sandbox adapter only, and no prices in the code.
Do not modify anything outside the task. If you find a conflict between the document and the code, ask me.
Finish with the "Done" checklist from section 1, run the tests, and open a PR.
```

**After each chat**: review the PR and run the tests yourself, tick the box in the phase, and update the feature's row in the section 2 table.

**Working in parallel**: two chats at the same time at most, and they must not touch the same files. Migration numbers are sequential (089, 090...), so only one chat creates migrations at a time, or reserve each chat's numbers up front.

## 23. Sources

**Direct observation from the project owner's accounts (October 1, 2026)**: the EasyOrders dashboard (sidebar, orders, order page, abandoned, products, store design and home builder, funnels, tracking, marketing, wallet, the app store with all its categories, settings, payment gateways, shipping and the list of companies), and the Lightfunnels dashboard (orders and order page, Checkouts, products, bundles, subscriptions, analytics and Live View and Sales Attribution, funnels and the map editor, apps, all settings tabs).

**The code**: [zimos-Backen](https://github.com/mustaphafahiim-maker/zimos-Backen) and [zimos-front](https://github.com/mustaphafahiim-maker/zimos-front) (last backend commit on September 27, 2026).

**Lightfunnels**

- [Funnel Page Types](https://docs.lightfunnels.com/funnel-pages/) · [Funnel Builder](https://docs.lightfunnels.com/introduction-to-the-funnel-builder/) · [Page Builder](https://docs.lightfunnels.com/introduction-to-the-page-builder/) · [Page Elements](https://docs.lightfunnels.com/page-elements/) · [Layout](https://docs.lightfunnels.com/elements-layout/) · [Styles](https://docs.lightfunnels.com/elements-styles/) · [Responsiveness](https://docs.lightfunnels.com/responsiveness/) · [Data Binding](https://docs.lightfunnels.com/data-binding/) · [Smart Sections](https://docs.lightfunnels.com/smart-sections/) · [Split Tests](https://docs.lightfunnels.com/split-tests/) · [E-Commerce Funnel](https://docs.lightfunnels.com/ecommerce-funnel/) · [Lead Funnel](https://docs.lightfunnels.com/create-a-lead-generation-funnel/)
- [Adding a Product](https://docs.lightfunnels.com/adding-a-product/) · [Importing a Product](https://docs.lightfunnels.com/importing-a-product/) · [Stock](https://docs.lightfunnels.com/lightfunnels-stock-management-documentation/) · [Reviews](https://docs.lightfunnels.com/product-reviews/) · [Price Bundles](https://docs.lightfunnels.com/price-bundles/) · [Discounts](https://docs.lightfunnels.com/discounts/) · [AI](https://docs.lightfunnels.com/ai-implementaiton/)
- [Order Fulfillment](https://docs.lightfunnels.com/order-fulfillment/) · [Editing an Order](https://docs.lightfunnels.com/editing-an-order/) · [Refunding](https://docs.lightfunnels.com/refunding-orders/) · [Canceling](https://docs.lightfunnels.com/canceling-an-order/) · [Abandoned Checkouts](https://docs.lightfunnels.com/abandoned-checkouts/) · [Cart Recovery](https://docs.lightfunnels.com/cart-recovery-app/) · [Order Email Updates](https://docs.lightfunnels.com/order-email-updates-app/)
- [Shipping](https://docs.lightfunnels.com/shipping/) · [Currencies](https://docs.lightfunnels.com/currencies/) · [Cash on Delivery](https://docs.lightfunnels.com/cash-on-delivery/) · [Stripe](https://docs.lightfunnels.com/stripe/) · [Security Layers](https://docs.lightfunnels.com/security-documentation/) · [Domains](https://docs.lightfunnels.com/domains/) · [Members](https://docs.lightfunnels.com/members/) · [Legal Pages](https://docs.lightfunnels.com/legal-pages/) · [General Settings](https://docs.lightfunnels.com/general-settings/)
- [Tracking](https://docs.lightfunnels.com/tracking/) · [Facebook CAPI](https://docs.lightfunnels.com/facebook-conversion-api-capi/) · [TikTok CAPI](https://docs.lightfunnels.com/tiktok-conversion-api-capi/) · [Dashboard Metrics](https://docs.lightfunnels.com/dashboard-metrics/) · [Live View](https://docs.lightfunnels.com/live-view/) · [Contact Segments](https://docs.lightfunnels.com/contact-segments/) · [GoIncognito](https://docs.lightfunnels.com/goincognito/) · [Google Sheet](https://docs.lightfunnels.com/google-sheet/) · [Shopify](https://docs.lightfunnels.com/shopify-integration/) · [Integrations](https://docs.lightfunnels.com/integrations/) · [Stores](https://docs.lightfunnels.com/stores/)
- [Pricing](https://www.lightfunnels.com/pricing) · [Developer API](https://developer.lightfunnels.com/)

**EasyOrders**

- [Dashboard documentation](https://dashboard-docs.easy-orders.net/) · [Public API](https://public-api-docs.easy-orders.net/) · [Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks) · [Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status) · [App install link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link) · [Themes documentation](https://themes-docs.easy-orders.net/)
- [Pricing](https://www.easyorders.eg/pricing) · [Official updates channel on Telegram](https://t.me/s/easyorders) (source for feature and pricing history; some details in it are unverified)

Any information marked "unverified" must be re-checked before building on it.

