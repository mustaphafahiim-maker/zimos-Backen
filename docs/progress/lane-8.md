# Lane 8 — Growth: contacts, stores, digital, AI, affiliates

## Done
- [x] 1. Contacts and segments (§18.4) — checked on :4108/:5208/:3208: orders and a hand-added lead show as customers/leads with tags, spend, last order and governorate; search, type/tag/segment filters, CSV export; segments saved with a live count (tags, orders, spend, governorate, product, consent rules each tried through `/segments/preview`); a `form` element on a published page submitted from the storefront creates a lead tagged from the page's own `tags` prop and lands in Form submissions; contact panel on the customer page (tags add/remove, forms, delivery rate) in Arabic and English.

## Next
- [ ] 2. All-my-stores overview and store switcher, duplicate store (§18.5). — built and landed; checked on :4108 by API (`GET /me/stores/overview`, `POST /workspaces/:id/duplicate` made "Demo Store Copy" with the product, variant and both site pages as drafts, no orders or customers); dashboard typechecks. **Still to do before ticking:** open `/stores` on :5208 (cards, "Open store", the Duplicate dialog, the "All my stores" entry in the header switcher) in Arabic and English — the browser check was not possible because the other lanes held 4 of the 5 dev-server slots.
- [ ] 3. Global search ⌘K, setup guide on real data, sidebar shortcuts (§18.6).
- [ ] 4. Digital products (§18.2): deliveries, licence codes, signed download links, file library.
- [ ] 5. AI module (§19): provider interface + sandbox provider, usage counter, product generation, funnel/page generation, translation, store policies — output always a draft.
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

## Blocked

## Handoff
- Branch `lane-8` in both worktrees; everything under Done is merged into `origin/zimos-additions`.
- Migrations used: 310. Next free: 311.
- Lane DB has demo data: 4 customers with COD orders, 3 leads, 2 segments, a published site "Lane 8 site" with `/contact` carrying a form (`form1`), and a second store "Demo Store Copy" made by the duplicate endpoint. The demo user's username is `demo`.
- Item 2 is landed but unticked: only its browser check is owed (see Next).
- Scratch API helper (not in the repo): log in as `demo@zimos.test` against `http://localhost:4108/api/v1`, workspace from `GET /workspaces`; POSTs to `/orders` need an `Idempotency-Key` header.
- The lane shares a 5-dev-server limit with other chats: stop the dashboard before starting the storefront.
