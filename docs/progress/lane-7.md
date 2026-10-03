# Lane 7 — Platform core: infrastructure, API, team, account

## Done
- [x] 1. Outbox + queue + worker — backend only — created an order on :4107: `domain_events` row dispatched, `events/dispatch` → `consume:automations`, `consume:server_pixels`, `consume:merchant_notifications` all completed, an `automation_runs` row and the bell notification appeared; 8 repeatable jobs registered in `queue_schedules`, `webhooks.retry` ran ok. How to use it: `src/core/queue/README.md`.
- [x] 2. Security fixes of §3.4 — backend + frontend — each of the 8 checked against the code:
  1. secrets: production refuses to boot without `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY` (≥32 chars, no placeholder); docker-compose has no default secrets — checked by loading env with NODE_ENV=production.
  2. refresh token: httpOnly cookie on `/api/v1/auth` for browser clients (`modules/auth/refreshCookie.js`), access token in memory only, Google callback no longer puts tokens in the URL — checked on :4107 (login/refresh/logout by cookie, admin cookie apart, body mode still works) and by driving the real bundled ApiClient through login → reload → refresh → logout and an old localStorage session.
  3. rate limiters: Redis store when `REDIS_URL` is set (`rateLimitStore.js`) — see Blocked.
  4. storage: production refuses `STORAGE_PROVIDER=local` unless `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true`.
  5. `listUnsettled` uses NOT EXISTS — `GET /settlements/unsettled` answers 200.
  6. Bosta webhook re-fetch: already in the merged code (`capabilities.webhookRefetch`), nothing to do.
  7. storefront security headers + CSP in `next.config.ts` — headers seen on :3207.
  8. phones masked in the customers and orders lists without `customers.reveal_sensitive` (`core/utils/phoneMask.js`).
- [x] 3. Public API (§16.2) — backend + dashboard — 41 operations under `/api/public/v1` (and still `/api/v1/public`): products (+ stock by SKU), categories, customers, discounts, shipping areas (+ bulk price update), webhooks, analytics summary, order create / status / notes / tracking; the 20 scopes with `requireScope`; `Api-Key` header; `X-RateLimit-*` headers; `docs/public-openapi.json` served at `/public-docs`. Checked on :4107 with three real keys (full, read-only, update-only): every route answered, an API order got source `api`, a read-only key got 403 on writes, an update-only key could not cancel. Dashboard: the new-key dialog picks access per kind of data (`ApiKeyAccessPicker.tsx`) — typechecked only, not seen in a browser.
- [x] 4. Webhooks (§16.1) — backend + dashboard — 20 topics (the 18 new ones fed by the outbox: `webhookTopics.js` → `webhookFanout.js`), per-endpoint filter by funnel/product, `failing_since` + hourly `webhooks.disable_failing` (off after 3 days, audit + bell notification, cleared on resume), store-wide delivery log (`GET /webhooks/deliveries`, resend one), `POST /webhooks/resend-orders`. Checked on :4107 with a local receiver: `/all` got product.updated, customer.created, order.created, order.confirmed with a signature; a product-filtered endpoint got only customer.created; resend delivered `resent: true`; an endpoint failing "for 4 days" was switched off, the bell row appeared, resume cleared it. Seen in the browser on :5207: scope picker dialog, add-endpoint dialog with the product filter, delivery log, "Resend to webhook" on the order page, and cookie sign-in surviving a reload.

## Next
- [ ] 5. App install link (§16.3); apps catalogue and `AppsPage` (§16.6); `DropshipProvider` interface + sandbox + README
- [ ] 6. Team (§17.1): invite dialog with section checkboxes, `fulfillment` role; sessions screen; two-factor on login; activity log screen; support access grant (§17.2)
- [ ] 7. `requirePlanLimit(key)` + `usage_counters` (§17.4, allowed part)
- [ ] 8. Platform-admin screens still missing (§17.5); queue status screen
- [ ] 9. GitHub Actions workflows for typecheck and build (§3.5)

## Decisions
- 2026-10-03 Worker runs inside the API process by default (`WORKER_IN_PROCESS`, like `WEBHOOKS_IN_PROCESS`), because today's deploy starts only the API; `npm run worker` + `WORKER_IN_PROCESS=false` splits it out (docker-compose does).
- 2026-10-03 Modules declare consumers/processors/schedules in their own `src/modules/<m>/jobs.js`, auto-discovered — no shared registry file for lanes to collide on.
- 2026-10-03 `outbox.record` writes inside a savepoint and falls back to running consumers after commit if the insert fails, so a lane that has not migrated yet never loses an order to the outbox.
- 2026-10-03 Under `NODE_ENV=test` events and jobs run inline after commit (same behaviour the old `emit` had), so Ziad's suite keeps seeing automation runs.
- 2026-10-03 The existing cron scripts (carrier sync, payment sweeps, trial check, upload sweep, webhook pass) are also registered as repeatable jobs; the scripts stay and running both is safe (each claims with row locks).
- 2026-10-03 Migration numbers used: 285.
- 2026-10-03 Refresh cookie is on by default outside production and **opt-in in production** (`AUTH_REFRESH_COOKIE=true`): it needs the dashboard and the API on the same site (app.x + api.x), and a cross-site deploy would sign merchants out on every reload. The dashboard handles both modes by itself (it stores a refresh token only if the server still sends one). Turn it on in production once the domains are in place.
- 2026-10-03 The cookie is named per app (`X-Zimos-App`: dashboard `zimos_rt`, admin `zimos_rt_admin`) so the two do not share a session on one API host. Refreshes are serialised across tabs with the Web Locks API, because the token rotates and a reused one revokes every session.
- 2026-10-03 Public API routes reuse the dashboard's validation schemas and controllers (`publicResourceRoutes.js`), so resource shapes are the internal ones (documented in the OpenAPI file); orders keep Ziad's public serializer. Categories are the dashboard's collections under the name integrations expect.
- 2026-10-03 Role permissions cannot tell create from update from delete, so routes check the scope by name too; the old `orders:write` stays valid as create+update+delete.
- 2026-10-03 "Shipping areas" = shipping zones with their rates; the bulk PATCH takes `{ rates: [{ rateId, …rate fields }] }`, all or nothing.
- 2026-10-03 Two small edits in lane 1's order files: `sourceFor` checks the API key before the user (API orders were being recorded as `manual`), and the list accepts `updatedSince` / `productId`.
- 2026-10-03 Events for changes that are already audited (product.created/updated/deleted, order.updated, order.uncancelled, order.paid, order.refunded, funnel.published, shipment.status_changed) are recorded from `recordAudit` itself (`core/outbox/auditEventBridge.js`) — one hook instead of an outbox line in every other lane's service.
- 2026-10-03 order.created / order.status_changed keep coming from Ziad's order change detector; the outbox consumer sends only the other topics, so nothing is sent twice. `order.fulfilled` = the order was delivered.
- 2026-10-03 A filtered endpoint still receives events that are about neither a product nor a funnel (customer.created, contact_form.submitted). "Resend order" goes out as `order.created` with `resent: true` and a new event id.
- 2026-10-03 checkout.created/updated/abandoned and lead.created are in the catalogue and are sent as soon as their lane records the event with `outbox.record` (lane 8 already records contact_form.submitted). "Resend to webhook" in the orders list's bulk bar is lane 1's screen: the endpoint takes up to 100 order ids.
- 2026-10-03 Migration numbers used: 285, 286.
- 2026-10-03 Only the owner role has `customers.reveal_sensitive` today, so managers and order operators now see masked phones in lists (full number on the order/customer page). System roles were not changed.
- 2026-10-03 Storefront CSP allows inline and any https script (pixels, tag managers and merchant custom code need it) and closes object-src, base-uri and http scripts; `STOREFRONT_FRAME_ANCESTORS` narrows who may frame a store (unset: anyone, so dashboard previews keep working).

## Blocked
- BullMQ driver: `npm install bullmq` fails on this machine (no registry access) and there is no Redis, so `src/core/queue/bullmqDriver.js` is written but never run, and `bullmq` is not in package.json. Whoever deploys with `REDIS_URL` must `npm install bullmq` and try it.

- Rate limiters on Redis: `rate-limit-redis` and `ioredis` cannot be installed here either; `rateLimitStore.js` uses them when present and falls back to memory with a warning. Never run against Redis.
- Browser checks depend on a free preview slot (5 dev servers per folder, shared with the other lanes); when none is free, screens are typechecked and their API calls exercised from node. The storefront CSP was only seen as headers, not with a store page loaded under it.

## Handoff
Branch `lane-7` in both repos. Items 1–4 landed. The demo user of zimos_lane_7 now has the username lane7.demo. Manual-check helpers are not in the repo (they lived in the chat's scratchpad): log in as demo@zimos.test on :4107 and query `zimos_lane_7` with `pg`.
