# API additions

What this branch adds on top of `main`, for review before merging. Everything
here is new files except the short list under "Changes to existing files".

Conventions followed from the existing code: `Router({ mergeParams: true })`,
`authenticate` → `resolveTenant` → `requirePermission(...)`, Joi schemas passed
to `validate({ params, query, body })`, `asyncHandler` controllers, `AppError`
for domain errors, `recordAudit` on every mutation, money in minor units.

## Migrations

Numbered 082–087 so they run after `079-add-fees-to-plans`,
`080-create-feature-flags` and `081-create-announcements`.

| # | Adds |
|---|---|
| 082 | `media_assets` — uploaded images per workspace |
| 083 | recovery columns on `checkout_sessions` (contact, cart, stage, converted/abandoned) |
| 084 | `low_stock_threshold` on `product_variants` |
| 085 | `workspace_integrations`, `whatsapp_conversations`, `whatsapp_messages` |
| 086 | `automation_runs` |
| 087 | `cod_settlements`, `cod_settlement_lines` |

## New endpoints

All workspace routes are under `/api/v1/workspaces/:workspaceId`.

### COD settlements — `/settlements`
Records what a courier actually remitted for delivered COD orders, and turns
that into real payments.

| Method | Path | Notes |
|---|---|---|
| GET | `/settlements/summary` | due from couriers, received, fees, draft count |
| GET | `/settlements/unsettled` | delivered COD orders not on any settlement, grouped by carrier |
| GET | `/settlements` | `?status&limit&before` |
| GET | `/settlements/:settlementId` | with its order lines |
| POST | `/settlements` | `{ carrierCode, reference?, periodStart?, periodEnd?, notes?, lines:[{orderId, collectedAmount?, feeAmount}] }` |
| PATCH | `/settlements/:settlementId` | draft only |
| DELETE | `/settlements/:settlementId` | draft only |
| POST | `/settlements/:settlementId/confirm` | writes a captured `cod` payment per line, updates `amountPaid` and the financial state, then locks the settlement |

Reads need `financial_reports.view`, writes need `refunds.manage`. An order can
appear on only one settlement (unique index on `workspace_id, order_id`).
Errors: `ORDER_NOT_SETTLEABLE`, `COLLECTED_EXCEEDS_DUE`, `DUPLICATE_ORDER` (422),
`SETTLEMENT_CONFIRMED` (409), `SETTLEMENT_EMPTY` (422).

### Order automations — `/automations`
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/automations` | rule list and create |
| PATCH/DELETE | `/automations/:ruleId` | |
| GET | `/automations/runs` | what fired, what was skipped, and why |

Triggers: `order.created`, `order.confirmed`, `order.rejected`,
`order.cancelled`, `order.shipped`, `order.out_for_delivery`,
`order.delivered`. Action: `whatsapp_template`. Tokens: `{{customer_name}}`,
`{{order_number}}`, `{{order_total}}`, `{{store_name}}`, `{{tracking_url}}`,
`{{city}}`. The engine is fired from `transaction.afterCommit` and never throws
into the request — a failed run is recorded, not raised.

### WhatsApp Cloud API — `/whatsapp`
| Method | Path | Notes |
|---|---|---|
| GET/PUT/DELETE | `/whatsapp/integration` | credentials are AES-256-GCM encrypted at rest (`INTEGRATIONS_ENCRYPTION_KEY`); the response only ever returns a masked token |
| GET | `/whatsapp/conversations` | `?status&search&limit&cursor` |
| PATCH | `/whatsapp/conversations/:conversationId` | close / reopen |
| GET | `/whatsapp/conversations/:conversationId/messages` | |
| POST | `/whatsapp/messages` | free text inside the 24h window, otherwise an approved template |

Public webhook, outside the workspace mount:
`GET|POST /api/v1/webhooks/whatsapp/:workspaceId` — verified with
`X-Hub-Signature-256` against the app secret, using `req.rawBody`.

### Abandoned checkouts — `/checkout-sessions`
| Method | Path | Notes |
|---|---|---|
| GET | `/checkout-sessions` | `?stage&limit&before` |
| PATCH | `/checkout-sessions/:sessionId` | mark recovered / dismissed |
| POST | `/store/:workspaceId/checkout-sessions` | public; the storefront upserts the session while the shopper is still typing. The checkout controller marks it converted when the order is placed. |

### Merchant records
| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/summary` | `?from&to` — revenue, orders, COD rate, top products, all computed from orders |
| GET | `/billing` | the merchant's own plan, subscription and usage |
| GET | `/audit-logs` | `?action&entityType&limit&before` |
| GET | `/invoices` | `?status&limit&before` |
| GET | `/media` and DELETE `/media/:mediaId` | the store's image library (upload already existed) |
| GET | `/confirmation-tasks/attempts`, `/confirmation-tasks/agents` | call-centre history and per-agent stats |

### Fraud rules — `/fraud`
| Method | Path | Notes |
|---|---|---|
| GET | `/fraud/flagged-orders` | |
| POST | `/fraud/flagged-orders/:orderId/approve` | clears the risk flags |
| GET/POST | `/fraud/blocklist` | blocked phone numbers = blacklisted customers |

Rules live in `settings.fraud_rules` and are evaluated on storefront orders
only (`!req.user`), so staff-created orders are never blocked.

### Platform admin — `/api/v1/admin`
New file `modules/platformAdmin/platformOpsRoutes.js`, same mount and the same
`requirePlatformAdmin` guard as `platformAdminRoutes.js`. Plans, subscriptions,
feature flags and announcements were deliberately **not** duplicated.

`GET /overview`, `GET /workspaces/:workspaceId`,
`PATCH /workspaces/:workspaceId/status`,
`PATCH /workspaces/:workspaceId/subscription`, `GET /users`,
`PATCH /users/:userId`, `GET /audit-logs`, `GET /templates`,
`PATCH /templates/:templateId`, `GET /system`.

An admin cannot demote or suspend their own account (`CANNOT_DEMOTE_SELF`).

### Public storefront
| Method | Path | Notes |
|---|---|---|
| GET | `/store/:workspaceId/shipping/quote` | `?country&region&subtotal&quantity&weightGrams` — same pricing path checkout uses |
| POST | `/store/:workspaceId/checkout-sessions` | see above |

`GET /store/:workspaceId` also returns two new read-only blocks:
`tracking` (public pixel IDs from `settings.tracking_pixels`) and `checkout`
(the checkout form behaviour from `settings.checkout_settings`).

Order tracking uses the existing `GET /store/:workspaceId/orders/track`; the
lookup endpoint that had been written separately was dropped.

## Changes to existing files

Kept as small as possible — nothing was restyled or refactored.

| File | Change |
|---|---|
| `src/app.js` | requires and mounts for the routers above; `express.json` now keeps `rawBody` for webhook signature checks |
| `src/modules/storefront/storefrontService.js` | `quoteShipping()` added; `getStorefront` also returns `tracking` and `checkout` |
| `src/modules/storefront/storefrontController.js` / `storefrontRoutes.js` / `storefrontValidation.js` | the two public routes above |
| `src/modules/checkout/checkoutController.js` | enforces `settings.checkout_settings`, marks the checkout session converted |
| `src/modules/orders/orderService.js`, `modules/cod/confirmationService.js` | emit automation triggers after commit |
| `src/modules/media/*` | list and delete, and the upload response now includes the asset `id` |
| `src/modules/billing/gatewaySignature.js` | the billing webhook is HMAC-verified (`BILLING_WEBHOOK_SECRET`) and refuses every request when the secret is unset |
| `src/modules/catalog/catalogValidation.js`, `db/models/ProductVariant.js` | `lowStockThreshold` on variants |
| `src/modules/workspaces/*` | `tracking_pixels`, `fraud_rules` and `checkout_settings` in workspace settings |
| `tests/integration/billing.test.js` | webhook requests are signed now |
| `tests/integration/mediaR2Storage.test.js` | the upload response includes `id` |

## Environment

New, all optional except where a feature is used:

```
BILLING_WEBHOOK_SECRET=        # required for POST /billing/webhook to accept anything
INTEGRATIONS_ENCRYPTION_KEY=   # 32-byte key (base64 or hex) for stored WhatsApp credentials
PUBLIC_API_URL=                # used to build the WhatsApp webhook URL shown in settings
```

Without these keys the features report themselves as not connected. Nothing is
stubbed or faked.

## Tests

`npm test` → 50 suites, 397 tests, all passing, with the new suites:
`settlements`, `automations`, `whatsapp`, `checkoutSessions`,
`fraudAndCheckoutSettings`, `trackingPixels`, `merchantRecords`,
`lowStockThreshold`, `platformOps`.
