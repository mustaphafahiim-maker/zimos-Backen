# Lane 8 — Growth: contacts, stores, digital, AI, affiliates

## Done
- [x] 1. Contacts and segments (§18.4) — checked on :4108/:5208/:3208: orders and a hand-added lead show as customers/leads with tags, spend, last order and governorate; search, type/tag/segment filters, CSV export; segments saved with a live count (tags, orders, spend, governorate, product, consent rules each tried through `/segments/preview`); a `form` element on a published page submitted from the storefront creates a lead tagged from the page's own `tags` prop and lands in Form submissions; contact panel on the customer page (tags add/remove, forms, delivery rate) in Arabic and English.
- [x] 2. All-my-stores overview and store switcher, duplicate store (§18.5) — checked on :4108/:5208: `GET /me/stores/overview` and the `/stores` cards (today's orders and sales, confirmation rate, money with couriers, alerts) in Arabic; `POST /workspaces/:id/duplicate` made "Demo Store Copy" with the product, variant and both site pages as drafts and no orders or customers; the Duplicate dialog and the "All my stores" entry in the header switcher.
- [x] 3. Global search ⌘K, setup guide on real data, sidebar shortcuts (§18.6) — checked on :4108/:5208: Ctrl+K opens the palette, a phone fragment finds its orders and customer and Enter opens the order; empty query lists actions and pages; the home page guide shows 80% with shipping still open; pinned pages show above the sidebar and persist per member (`PUT /shortcuts`).

## Next
- [ ] 4. Digital products (§18.2): deliveries, licence codes, signed download links, file library. — built and landed (migration 312, `modules/digital`, dashboard `/digital` + order-page card, storefront `/downloads/:token` + links on the tracking page). Checked in-process against the lane DB (scratch script calling the service): upload, file/link/code deliveries, a paid order got its grants and went `fulfilled`, the download limit refused the 3rd download, late codes filled a short grant, renew/revoke, `order.digital_delivered` in the outbox. HTTP routes then checked on :4108 (products, files, multipart upload with an Arabic file name, public download by token). **Still to do before ticking:** the three screens in a browser (`/digital` both tabs + upload, an order page with grants, the storefront download page) — every dev-server slot was held by other lanes.
- [ ] 5. AI module (§19) — built and landed (migration 313, `modules/ai` with README contract, sandbox provider, four versioned prompts, `ai` queue processor, usage ledger; dashboard `/ai` "AI studio"). Checked on :4108 by API: product, page, translate and policies jobs all went queued → succeeded through the queue; apply made a draft product and an unpublished page `/tshirt-offer`; a second apply answered 409; usage counted 4 requests. Dashboard typechecks. **Still to do before ticking:** open `/ai` on :5208 and run each of the four tools in Arabic and English (the dashboard session had expired and the usage limit of this chat was reached before logging in again).
- [ ] 6. Affiliates (§20.3): affiliates, commissions on delivered orders, a simple OTP portal.
- [ ] 7. Dashboard as a PWA (manifest, install prompt) (§20.1 first step).
- [ ] 8. Subscriptions and installments on the sandbox gateway (§18.1); courses (§18.3); shoppable images (§7.9); services marketplace (§20.5).

## Decisions
- 2026-10-03 Contact `type`, `totalSpent`, `lastOrderAt` and the delivery rate are computed from the live orders (one CTE over the derived stage, `contacts/segmentRules.js`), not stored: no hook into the orders module, and nothing to drift. Stored on `customers`: `tags` and `source` only. `segments` (the old unused array) was copied into `tags` and left in place.
- 2026-10-03 Total spent = orders whose stage is not cancelled, returned or awaiting payment. Delivery rate = delivered ÷ (delivered + returned + delivery failed); null until a parcel reaches an end.
- 2026-10-03 Segment rules are one flat object, all keys ANDed (see `segmentRules.js`). `contactService.resolveSegment(workspaceId, segmentId)` is the entry point for senders (lane 4 campaigns): consenting, non-blacklisted contacts only by default.
- 2026-10-03 A contact is keyed on phone (existing model), so a form submit with an email but no phone is kept in `form_submissions` without creating a contact.
- 2026-10-03 The tags a page form adds are read by the server from the published page (`elementId` + `pagePath`), never taken from the request. Forms inside funnel steps are stored but add no tags yet.
- 2026-10-03 `contact_form.submitted` is written with lane 7's `outbox.record` in the submit's own transaction (payload: `submissionId`, `customerId`, `formName`). No consumer is registered for it yet.
- 2026-10-03 New permission `form_submissions.view` (owner, workspace manager). Export needs `customers.reveal_sensitive`.
- 2026-10-03 The storefront `form` element now has four fixed fields (name, phone, email, message) plus an optional consent box; custom field definitions wait for lane 5's form inputs. `/customers` is now the Contacts screen (the old `CustomersPage.tsx` was replaced); the customer page keeps its URL.

- 2026-10-03 "Balance" on the stores overview = delivered COD money couriers have not settled yet (`settlementStatementService.held`), shown only with `financial_reports.view`; order figures only with `orders.view`. Confirmation rate = confirmed ÷ (confirmed + rejected) COD orders of the last 30 days. "Today" is each store's own timezone.
- 2026-10-03 Duplicate store goes through `workspaceService.createWorkspace` (plan store limit applies) and copies collections, non-archived products, variants (stock as a starting figure, nothing reserved), offers, websites and pages as drafts, shipping zones/rates/weight tiers, tax rates, theme and settings (minus `tracking_pixels`; `order_bump.offer_id` is remapped). Media rows, reviews, team, integrations, carrier/gateway accounts and domains are not copied. If the copy fails the new store is marked `closed`.
- 2026-10-03 The header already had a store switcher; it gained an "All my stores" entry rather than being rebuilt.

- 2026-10-03 ⌘K: records come from the API; pages and actions are matched in the dashboard in the current language. The setup guide hides itself at 100% and can be dismissed per browser (localStorage), not per account.

- 2026-10-03 Digital delivery fires from `orderStateService.setFinancialState` when an order becomes `paid` (one hook line, inside a savepoint so a delivery problem cannot undo a payment); a COD order therefore delivers only when its payment is recorded. An all-digital order is marked `fulfilled` at that moment.
- 2026-10-03 Files are private (`storage.putPrivate`, key `digital/<ws>/<id>`) and streamed by the API after the grant token, expiry and download limit are checked; the token (random 64 hex, stored) is the "signed link". Upload is one multipart request capped at 100 MB — presigned multipart to R2 and a per-plan size limit are left to the storage integration; `link` delivery covers bigger files.
- 2026-10-03 A grant snapshots the delivery at payment time. Licence codes: one per unit bought, drawn with `FOR UPDATE SKIP LOCKED`; if stock runs short the grant records `codesMissing` and is filled when codes are added. Email/WhatsApp delivery is left to automations via the `order.digital_delivered` event.
- 2026-10-03 `downloads` is now a reserved storefront path (`RESERVED_PAGE_SEGMENTS`).

- 2026-10-03 AI: a request is an `ai_jobs` row run on lane 7's `ai` queue and polled by the dashboard. Monthly limit = `ai_requests_per_month` in the plan's features (absent = none) plus a fixed guard of 30 requests/hour. The sandbox provider is refused in production. Apply: product → draft product; page → unpublished website page; translation and policies are copied by hand (policies belong to lane 5's store info screen).

## Blocked

## Handoff
- Branch `lane-8` in both worktrees; everything under Done is merged into `origin/zimos-additions`.
- Migrations used: 310–313. Next free: 314.
- Item 5 is landed but unticked: its browser check is owed (see Next). Log in again on :5208 first (demo@zimos.test).
- Item 4 is landed but unticked: its browser/HTTP check is owed (see Next). The lane DB has two digital products (`EBOOK-1` file delivery, `LICENCE-1` codes) and a paid order `ORD-DIGI-…` with grants, made by the scratch script.
- Setup guide: `payment` is done whenever the storefront offers a method (COD counts); `domain` and `pixel` are optional and outside the percentage. Shortcuts live on `memberships.nav_shortcuts` (max 8 dashboard routes).
- Lane DB has demo data: 4 customers with COD orders, 3 leads, 2 segments, a published site "Lane 8 site" with `/contact` carrying a form (`form1`), and a second store "Demo Store Copy" made by the duplicate endpoint. The demo user's username is `demo`.
- Scratch API helper (not in the repo): log in as `demo@zimos.test` against `http://localhost:4108/api/v1`, workspace from `GET /workspaces`; POSTs to `/orders` need an `Idempotency-Key` header.
- The lane shares a 5-dev-server limit with other chats: stop the dashboard before starting the storefront.
