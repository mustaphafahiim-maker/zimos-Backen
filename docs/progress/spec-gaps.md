# SPEC gaps — the work queue (from 2026-10-03)

What docs/SPEC.md asks for that the code does not do yet, found by comparing
each section with the backend routes, the api-client and the screens. The
lanes' own progress files tick everything; these are the gaps behind the ticks.
Worked top to bottom on `claude/gracious-cori-p3g4hr`, one feature per commit,
verified by running it on a scratch database. Migrations for this queue use
the numbers **400–449** (no lane owns them).

## Decisions

- Marketing = `checkout.abandoned`, `lost_order.created`, `review.request`, `lead.created` (automations/marketingGuard.js). Order updates still go to a phone that said STOP: the customer asked for them by ordering.
- A STOP is stored per phone in `marketing_opt_outs`, not on customers: an abandoned checkout has no customer row. A newsletter sign-up by that phone removes it; a staff edit of the customer does not.
- A marketing SMS gets "للإيقاف أرسل: إيقاف" appended unless it already says how to stop. WhatsApp template texts carry it in their body. Email has no unsubscribe link yet (no email reply handling).
- The sandbox courier exists outside production for every store; in production only with `CARRIERS_SANDBOX=true` and the FeatureFlag `sandbox_integrations` (shared check: `core/utils/featureFlags.js`). Its parcel state lives on the shipment (`carrier_response.sandboxStatus`), so it survives restarts and the poller sees it.
- Storefront cache (`storefront/storefrontCache.js`): raw data only (store, product lists and pages, collections), localized after the read; Redis when `REDIS_URL`, else memory; dropped when an audited store-visible change commits and when the merchant restocks or adjusts stock; not on orders (stock shown ≤ 60 s old; checkout checks real stock). The storefront's Next.js pages stay per-request on purpose (shopper IP for rate limits, staff preview, locale cookie — see `lib/serverApiClient.ts`); they read through this cache instead of ISR.
- A single courier booking stays inside the request: a courier create is never retried automatically (a retry after a timeout could book the parcel twice — the adapters say so), and the merchant waits for the waybill. Bulk shipping goes through the queue (item 10).
- Automatic booking (`shipping/carrierBooking.js`) runs on `order.confirmed` / `order.paid` on the carriers queue with the default courier (or the only one set to book on its own), and is never retried for the same reason. A failed one — address not in the courier list, courier refusal — becomes a per-order merchant notification plus an audit row on the order, and the merchant books it by hand. Test orders are booked automatically only by the sandbox courier. An order that already has an active shipment is left alone.
- Places (`geo_regions`, migration 403): two levels, governorate (Egypt's 27 + North Coast, Saudi Arabia's 13 regions) and city (343 in Egypt, 84 in Saudi Arabia). Egyptian governorates keep their existing codes; North Coast is `north-coast`; Saudi regions are `sa-*`; cities are `<parent>.<slug>`. The list changes only by migration. The storefront form still takes the city as free text; the order's text is read back to a place when booking.
- Courier area map (`carrier_region_map`, migration 404): rows matched by name are shared by every store (`workspace_id` null), because a courier's list is the same for everyone, and are refreshed at most daily when a store opens the Areas screen. A store's own choice is stored per store and wins. A pick made on one order's booking is not remembered as the area's mapping: that order's street may not represent the area. Mappings are set only from the Areas screen.
- The sandbox courier now has two levels (city > district, Bosta-shaped) built from `geo_regions`, with North Coast towns under Alexandria and Matrouh, so district picking and mapping can be exercised.
- Bulk shipping with a connected courier (`shipping/bulkShipping.js`, migration 405) is a batch on the carriers queue: preview (ready / missing an area / cannot ship) → batch → one booking at a time, each through `createCarrierShipment` exactly as from the order page, recorded as the person who started it. A booking is never repeated on its own: an item left `booking` by a crashed run becomes booked if its order now has the shipment, else failed "interrupted". Only the merchant sends failed ones again (`/retry`). The old synchronous `POST /orders/bulk` action `ship` stays for manual courier names; the dashboard sends a connected courier through the batch.
- A missing area is fixed in the dialog on the areas map when the order's city is on the platform's list (every order from there follows), else for that order only (`addresses`).
- Orders list columns and saved views stay per device (localStorage), as they were: SPEC says "saved per user"; moving them to the server is a separate change, not needed for any flow. Export selected goes through the export's `ids` filter (≤ 100 ids, a GET URL); resend to webhook uses the existing `POST /webhooks/resend-orders` (≤ 100, webhooks.manage).
- "Notify the customer" on a cancellation or refund is `notifyCustomer` on the event payload: false sends no order email and skips the store's automations for that event (webhooks and everything else still run); true sends the order email even while that template is switched off; unset follows the settings. A gateway refund settled later by webhook follows the settings. A cancellation with `refundAmount` stands when the refund fails (`refundError`).
- "Confirm via WhatsApp" sends the ready-made automation's `order_confirmation` template (it must be approved on Meta under that name); without WhatsApp it is a wa.me link from the merchant's own phone. Editing the customer on an order changes the order's snapshot only, not the customer profile.
- A checkout is captured from a name alone (phone_normalized null, migration 406) or from a valid number for the form's country (an Egyptian mobile on an Egyptian form, 8–15 digits otherwise), 800 ms after typing stops. A save without a number keeps the number the session already has. The server still normalises a non-Egyptian local number with the Egyptian default, as orders do; a store country setting would fix both.
- `checkout.created` is the first autosave of a session; `checkout.updated` follows a new number or other lines at once, and a name/email edit at most once a minute per session (autosaves fire at every pause in typing). The payload carries the contact, the lines, the total and the product ids (for endpoint filters).
- "Save my card" is the shopper's tick at checkout (`saveCard`, kept in the order's completion context); the card is saved after the payment is captured, with the gateway's token only. A funnel offer accepted after an order paid with a card saved that way is a card order charged to it at once (outside the session transaction); declined, it stays unpaid and expires, and the first order is untouched. Without a consented card the offer is cash on delivery, as before.
- A funnel's currency is applied without converting prices: the funnel publishes only when its offers, order bump and page product are priced in its currency, and an order placed on it in another currency is refused (FUNNEL_CURRENCY_MISMATCH). What a shopper is charged is the price the merchant set; FX conversion of charges waits on the rate provider, an open decision (SPEC §11.5).
- The storefront display currency is display only: the header switcher (and the builder `currency_converter` element, which shares the choice) adds an "≈" amount under the price in the chosen currency from the store rates; the cart, checkout and charge stay in the price currency. The choice is remembered per store in the browser; "convert automatically" picks the visitor currency from the browser language region on a first visit when the store lists it.
- Reports add orders up in the store base currency (currencies/baseAmounts.js): the order total is its recorded `total_amount_base`, and its other amounts (refunds, discounts, shipping, lines) are converted by that order own base/total ratio, so the rate is the one of the day it was placed. Applies to attribution, ad campaigns, P&L, the overview, the analytics summary and funnel analytics. Product costs and product economics are entered in the store currency and are not converted. An order placed when no rate was known counts at its own amounts, as before.
- `Lead` fires from the browser on a newsletter sign-up (footer band and popup) and on a funnel opt-in step, with a browser event id the server relay reuses. The builder `form` element is a contact form (`contact_form.submitted`) and sends no Lead. Headless browsers are dropped as bots by the events endpoint, so a browser check needs a desktop user agent.
- Exporting the orders list (the Export button) is built in the `io` queue (`POST /exports/orders`, migration 407 `export_files`); the file goes to private storage and an `export.ready` notification (bell and email, now on by default) links to `/exports/:id`, where the teammate who asked downloads it with their session. Only that teammate sees it; it is kept 7 days, then the sweep removes it (410 after). Exporting ticked orders (at most 100) still downloads at once.
- `integration.failed` (notifications/integrationAlerts.js) is sent for the connection itself only: a gateway that refuses the keys or does not answer (starting a payment, refunds, status checks, saved-card charges), a payment webhook whose signature does not match the stored secret, a courier refusing the stored key or a permission (every call through `withAuthHandling`), WhatsApp refusing the token or not answering. A declined card, an address or an undeliverable number are not. Once a day per integration and reason; it never waits on or fails the call. WhatsApp webhooks with a bad signature send nothing: the URL carries only the public store id, so anyone could trigger it. Still open: a subscription renewal whose gateway refuses the keys is counted against the shopper (subscriptions/subscriptionService failRenewal) — the merchant is now told, but the renewal still fails.
- Orders are attributed by their own touch (analytics/orderTouch.js): the last unless the merchant picks first, the other one when that is missing, the whole touch at once; an order from before touches were kept uses its purchase event. Attribution, the campaigns screen and P&L by campaign all read it, so a campaign has the same orders everywhere. Visitors stay per visit (events): a visitor has no order to carry a touch.
- `analytics_daily` (migration 408) holds the overview's event counts per store day, for the store and per funnel. The overview reads whole days from it and counts the partial days at the window's edges (always today) from raw events, so it stays exact; a row counted before its day ended (+10 min) is recounted on the spot, which also fills old ranges once. `analytics.rollup_days` (every 30 min) counts finished days after each store's midnight. Total visits are now the sum of daily visits (a session past midnight counts on both days). Orders, lost checkouts and the breakdowns (sources, devices…) still query their tables.
- The team screen groups people who joined into Admins (owner and the Admin invite, `workspace_manager`) and Members (every other role); pending invites stay in their own table. The seat counter is the API's (`/team/access-options`: members and pending invites); the old `POST /workspaces/:id/members` invite now has the same seat limit as `/team/invite`.
- The phone verification code and the WhatsApp sign-in code go through the platform's WhatsApp provider (authentication template), SMS when WhatsApp cannot deliver, and — for sign-in — email when there is no verified phone any more, so nobody is locked out. WhatsApp two-step sign-in can only be turned on with a verified phone.
- Account settings (`/workspaces/:id/account-settings`, workspace.manage): the timezone column, `settings.account.contact_form_email` (each `contact_form.submitted` is emailed there by contacts/jobs.js; empty = bell/list only) and `settings.account.legal` (name, company, phone, address, country) printed under the store name on invoices. A new timezone drops the store's analytics_daily rows so they are recounted on the new days. Store contact details (settings.store_info) stay the storefront's.
- Plan limits on leads and storage (billing/limitGuards.js): `leads` = contacts created this calendar month (UTC, as usage_counters) by forms and the newsletter; past it a NEW lead is refused with 402 at the form/newsletter (someone the store knows is never refused) and the merchant gets `plan.limit_reached` once a month. Manual contacts by staff are not limited. `storage_bytes` = media library + digital product files (shoppers' photos are not counted); an upload that would pass it is refused. The usage block shows new leads this month.
- Digital delivery: the thank-you page asks `GET /store/:ws/downloads/order/:orderId` with the order's payment token (the online checkout's credential) a few times over ~50 s, since the payment is often captured just after the shopper lands; a COD order has no token and shows nothing there (its links come with the tracking page once paid). The message is the ready-made automation `digital_delivery` on the new trigger `order.digital_delivered` (WhatsApp template with the signed order link); the email was already sent by orderEmailService.
- Shipping groups (migration 410 `shipping_profiles`, `products.shipping_profile_id`): a group's price for a destination is its governorate price, else its flat price, else none. The parcel travels once, so an order pays the dearest price that applies — each group's for its products and the store's own rate for products in no group (rule `profile_rate`). Free shipping, offer overrides and the free threshold still win first; extra-fee products still add their fee. Products are assigned from the group (a product is in one group at most); deleting a group sends its products back to the store's prices.
- AI funnel: a generated page (feature `page`) applied with `target: funnel` becomes a new draft funnel in one transaction — the page as the sales step (its product-page button links removed so the funnel's edges lead on), a checkout with the COD form and a thank-you page, edges always / completed_checkout, step names in the job's dialect, a link made unique like createFunnel's, counted against the plan. Needs funnels.manage (the AI routes now also accept it). The product form's "Write with AI" fills the description field only (not saved until the product is); creating a whole product stays in the AI Studio.
- Shipping options (settings.shipping_options): `standard` is always the store's computed price (groups, free shipping and all); up to five more either add an amount to it (express: still charged when shipping is free) or cost exactly an amount (pickup). The quote lists them once a price is known; the checkout sends `shippingOption`, an unknown or switched-off one is refused, and the order keeps the pick in `shipping_snapshot.option` (shown on the order page). No extra option = no choice, exactly as before. Wired into the cart checkout and the product page form; funnel COD forms still charge the standard price.
- Push: `device_tokens` (migration 411) per person, registered from the dashboard (`/me/push/devices`); `push` is a third merchant-notification channel, on by default for new/suspicious orders, integration failures, exports, bulk shipping, automations and plan limits. Providers follow notifications/push/README.md; only `sandbox` exists (records each push in notification_logs, channel `push`, added to its enum); the real `webpush` adapter needs VAPID keys and the `web-push` package (not installed). The dashboard service worker already shows `{title, body, link}` and opens the link on tap.
- Orders board (`/orders/board`): one column per working stage (cancelled and awaiting-payment orders stay in the list); each pages its own `GET /orders?stage=`; moves go through `PATCH /orders/:id/status`, so the server decides what is allowed and refuses the rest with its own message. Saved views live per teammate in `saved_views` (migration 412, scopes orders/lost_orders/customers/products); views a browser kept in localStorage are copied up once on first load.
- Shipping page tabs (§12.5): Shipping prices (settings, groups, weight tiers, zones), Shipping options, Shipping companies, Taxes; the tab is `?tab=` so links open it. Each carrier listing carries `countries` (adapter field, default ['EG']); the companies tab gets a name search and a country select that appears once the list spans two countries. The daily manifest already existed (order documents, "Today's manifest").
- Support access enforced: the platform console had no way into a store's own data, so support now opens it through one audited endpoint, `POST /admin/workspaces/:id/support-view` (support.view) with a required reason — team, domains, couriers/gateways/integrations, the latest 20 orders without customer details, recent integration and plan-limit alerts, and the store's activity log. It answers 403 SUPPORT_ACCESS_NOT_GRANTED unless the merchant's grant is active, and every opening is written to the store's own activity log (`support.access_used`, with the reason) where the merchant sees it. Anything later added for support inside a store goes through `assertGranted` the same way.
- Apps gate their features (apps/appGate.js): the six features every store already had (tracking tools, webhooks, public API, WhatsApp, fake-order protection, offers) are `standard` apps — on until the store uninstalls them, so no store lost anything; any other app (the test supplier) is off until installed. Uninstalled means: the dashboard refuses creating and changing (403 APP_NOT_INSTALLED) but still shows the setup and lets it be removed; and at run time no pixel loads and no server event is sent, the store's own webhook endpoints stop (deliveries kept as failed, an outside app's keep going), API keys stop except an installed outside app's, nothing is sent from the store's WhatsApp number (logins and codes use the platform's), the store's fraud rules and risk score don't run (the platform blocklist still does; held orders can still be approved), and the shop shows no bumps, cross-sell, upsell or exit offer (a stale ticked add-on is refused). Quantity bundles keep pricing, so carts and funnels don't change price. Each process caches a store's apps for 30 s; install/uninstall clear the storefront cache.
- Couriers' areas map in the platform console (`/carriers/:code/areas`): per courier and country, every city with its shared mapping (name-matched or the platform's choice), how many stores picked something else and what. `providers.manage` (new, migration 413, added to the admin role) makes a store's pick, or the current mapping, the platform's choice for every store; it can only be a path already on the map, since each was checked against the courier's list when a store chose it and the console holds no courier account. Daily name matching never replaces a platform choice; a store's own choice still wins for that store; "back to name matching" removes the choice (booking falls back to the order's text until the next match). The theme catalog moves to item 47, which creates the themes tables it needs; the template catalog was already in the console.
- Segments in automations: a rule may run only for contacts in a segment (`conditions.segmentId`) and/or never for those in another (`excludeSegmentId`), checked when the rule starts, for every trigger that names a contact (an order's customer, a lost checkout's by its phone, a lead, a subscription's customer). A deleted segment skips the rule ("the segment was deleted") rather than running it for everyone. Bulk sends to a whole segment stay out (§21, no campaigns).
- Tags from funnel buttons: a button, an order form (`cod_form`) and the offer accept/decline buttons take `contactTags` in the builder; the funnel runtime adds them, from the published snapshot (never from the browser), to the customer who ordered in that session — on the button's `clicked_through`, on `completed_checkout` (the step's order forms) and on accepting/declining the offer. A button pressed before any order tags nobody (the funnel does not know the visitor yet). Contact forms on funnel steps now get their own `tags` too (they were only read on store pages).
- Store app (PWA, §20.2): `settings.store_app` {enabled, name, short_name, icon_url, theme_color}, edited under Store settings → General (website.publish); GET /store/:ws carries `storeApp` (null while off). The storefront answers `manifest.webmanifest` per store (relative start_url/scope, so it opens on the store's home on its subdomain, its domain or /store/<ref>), registers `/store-sw.js` for the store's path — it caches nothing, so prices and stock are never stale, and shows an offline notice — and offers "Install the app" where the browser allows it (the Share-menu hint on iPhone), dismissible per browser. No icon set: the logo, else the ZIMOS icon.
- Shopper push (§20.2): with the store app on, the thank-you page offers "Notify me"; that browser follows that one order (`order_push_subscriptions`, migration 414, at most 5 per order), proven by the order number shown on the page. Confirmation, shipping, out for delivery, delivery and cancellation are pushed in the store's language with the tracking link, through the push provider (sandbox: written to the notification log); a change the staff marked "don't notify the customer" is not pushed. No marketing pushes (§21).
- ZIMOS referral program for merchants (§20.4): the share is an open decision, so it is a platform setting (`platform_settings` key `merchant_referral_program` {open, rateBp}, migration 415), set in the console (Referral program, agents.manage); unset or closed, nobody can join. Joining gives the merchant an ordinary referral code (label `merchant`, the share stored on the code, so a later change applies to new members only) and a sign-up link `/register?ref=CODE`; the dashboard keeps the code from the link and offers it in Billing once the new store exists. Earnings use the existing commission ledger (they show on the Agents page too); a merchant's own code is refused on stores they are a member of (SELF_REFERRAL). The "Refer & earn" screen shows the link, share, stores that used the code, owed/paid, earnings without store names, and a payout request (Vodafone Cash / InstaPay / bank, one waiting at a time); the console marks a request paid (which marks the commission rows owed when it was asked as paid) or declines it.
- WhatsApp bot (§19.3, part 1): `settings.wa_bot` (on/off, always or working hours on the store's clock, tone/dialect, extra information), at Inbox → Bot (changes: workspace.manage). Each typed customer message is queued (queue `ai`); the bot answers through the AI provider (`support_reply`, sandbox rules) from the store's policies and extra information, active products with price and stock, and the customer's own orders found by their WhatsApp number — never a discount. It hands the chat to the team (bell notification, conversation stays open) when it can't answer, the customer asks for a person or is upset; then it stays quiet in that conversation (migration 416 `bot_paused_at`) until someone presses "Let the bot answer". A teammate's typed reply, or "Take over", pauses it too. Only the newest waiting message is answered. Bot messages carry a badge; replies a month are counted (`sent_by_bot`) against the plan's `bot_replies` limit (unset = no limit); at the limit the conversation goes to the team. "Try it" asks the bot without sending anything.
- WhatsApp bot (§19.3, part 2): ordering in the chat is a guided form, not left to the model — "عايز اطلب"/"order" starts it; product (numbered list of what is in stock) → option → quantity (1–10) → name → governorate → city → address → a summary with items, shipping, tax and the cash-on-delivery total from the same pricing as the website → "تأكيد" places a normal storefront COD order (prices, stock, shipping, tax and the store's fraud rules apply), tagged `whatsapp-bot` with a note; "إلغاء" stops at any step, a flow left 2 hours starts over (`bot_state`). A refused order hands the chat to the team. Bot orders keep source `store` (the source list is a shared type), the tag tells them apart.
- Inbox "Create order" opens `/orders/new?phone=&name=` from the conversation: the number is looked up at once, and a known customer's saved name and last address fill the form (their saved name wins over the WhatsApp profile name). Frontend only.
- Cross-sell at checkout and on the thank-you page: the same strip as the cart, asking `/cross-sell` with placement `checkout` / `thank_you` for the products in the cart / the order just placed. A product opened from the strip carries `?from=cross_sell`, and a click inside the strip (quick add) marks the next add, so `add_to_cart` is sent with `source: cross_sell` in its metadata. Storefront only.
- Product order bumps on `/checkout`: the add-ons of every product in the cart (one card per offer, none for a product already in the cart, the store-wide bump left to its own card), ticked-by-default rules start ticked; ticked ones go into the totals and the shipping quote and are sent as `orderBumps`, which the server checks against the cart (a refusal unticks them and reloads). Storefront only.
- Product list: search (name), SKU, collection, type and stock filters now go to the server (GET /catalog/products q/sku/collectionId/productType/stock, typing debounced), so they cover the whole catalog, not the loaded page; a Created column; digital products and services show "Not tracked" for stock; "Preview" opens the product in the store (archived ones have none). Frontend only — the backend filters already existed.
- Product SEO: `product.seo` {title, description, imageUrl, noindex} is now validated (lengths, http(s) image; other keys kept) and edited in the product form's "Search engines and sharing" card with a Google preview. The storefront's product metadata uses the title, description and sharing image and sends `noindex, follow` when hidden; the sitemap leaves hidden products out.
- Product page settings on the store: `auto_select_variant` (default on) off leaves every option unchosen and the buy box says "Choose options" until the shopper picks; `landing_page_id` renders that published website page at the product URL with the product as the page's product (an inactive or missing page falls back to the standard page; picked in the product form from the store's website pages); "Similar products" (4, the first collection, else the newest) sits under the reviews and `hide_related_products` hides it.
- Funnel runtime: the step endpoint now returns the funnel and its own settings (as the start already did). A step page shows prices in the funnel's currency (falling back to the store's) — the page's elements, the checkout line, the orders summary and the pixel `ViewContent` — and its tab title, description and icon are the step's own SEO first, then the funnel's title/description/favicon, then the step name and the store's icon. The entry page `/f/<ref>` keeps its generic title (it only starts the session and moves on).
- Custom-field prices: a field takes `priceDeltaAmount` (minor units, ≥ 0), added to the line's unit price when the shopper fills the field in (an empty answer adds nothing; a bundle/offer line adds it per offer unit). The amount is read from the product as it is now in `priceLine` (order, shipping quote, abandoned checkout) and the cart totals (catalog/customFieldPricing.js), and kept on the answer's snapshot so the order shows it. The product form shows "+20" by the field and a "Personalisation" row in its total; the shipping quote is not re-asked per keystroke, so a free-shipping threshold crossed only by field prices shows on the order, not the form. Staff edits keep a kept line's stored price. The waybill (A5 and the bulk labels, as many lines as fit) prints "<product> — <field>: <answer>" for every answered field, a photo as "photo on the order page".
- Shopper reviews (reviews/shopperReviews.js): proof of purchase is the order number AND its phone for a delivered order of the product — a phone alone no longer answers "did this number buy it?". Every mismatch is the same 403 REVIEW_NOT_VERIFIED and the form is limited to 10 tries a minute per IP. Up to three photos, uploaded first like a custom-field photo (same visitor id), are moved to public storage when the review is sent and their private copies dropped; the review still waits for approval. The phone-only `submitReview` and its route are gone.
- Reviews import (reviews/import): an importer contract (README) with a sandbox, chosen by REVIEW_IMPORT_PROVIDER and refused in production until a real one (which Shopify reviews app, and how the store hands over its token, is an open decision). The service filters (photos only, minimum rating, language), skips a review already imported (same author, rating and text on the product), keeps photo links as given and stores source `import`: named, deletable like a manual review, never "verified" (only `customer` reviews are), waiting for approval unless the merchant ticks "show now". Dashboard: "Import reviews" beside "Add review".
- Store `<html lang dir>` is server-rendered: the proxy names the store on every store request (`x-store-ref`: the subdomain slug, or the id from /store/<id>/…), and the root layout reads the store and the shopper's language cookie, so the first HTML already says ar/rtl or en/ltr. Anything that is not a store keeps en/ltr. (41a)
- Page and funnel translations (translations/contentTranslations.js): what is offered is what is live — the published website's pages (their tree texts and title) and published funnels (all steps' tree texts, one entity per funnel). Texts are the text props of elements (headings, paragraphs, labels, Q&A, bullet items; never links, images, ids, bound data, form choices) and each is stored with `field` = a hash of the original, so a repeated sentence is translated once, moving an element keeps it, and an edited sentence shows as untranslated. The public page and funnel step answers are laid over for X-Store-Locale when the store offers that language; the Languages overview counts these texts too. Dashboard: Pages and Funnels tabs in Store settings → Languages. (41b)
- "Translate what's missing with AI" (translations/aiFill.js): per language and kind (products, collections, pages, funnels), the untranslated texts go to the AI `translate` feature as ordinary AI jobs of 20 texts, at most five jobs per click (the plan's AI limits and usage apply; the sandbox answers until a provider is chosen). Each job remembers which text every answer is for; the dashboard polls /ai/apply, which saves the answers and never overwrites a translation saved meanwhile. AI translation is offered for Arabic, English and French (the AI feature's languages); the others are translated by hand. (41c)
- Page settings in the builder (website editor toolbar and the funnel step page view): an SEO tab (title, description, sharing image; "hide from search engines" for website pages → robots noindex) saved as the page's `seo` (live with the next publish) or the step's `seo` in the funnel draft; and a Scripts tab (code in <head> and before </body>). Page scripts follow the custom-code rules (§8.4): kept outside the tree in workspace_custom_code (`ph:`/`pb:` + page id, `sh:`/`sb:` + funnel step id; published funnel snapshots now carry each step's id), website.publish to read or write, audited, live at once rather than with a publish, sent with the live page or step but never to a staff preview, and run by the storefront only on the store's own host and never on payment pages. A split-test variant has no page settings of its own.
- Funnel map (FlowMapTools.tsx): the wheel zooms around the pointer (40–160%, plus −/+/fit buttons) and dragging the empty map pans it; each card shows a schematic thumbnail of its page (a row per section, a block per element, the first four sections) and its numbers for 7/30/90 days from the funnel analytics: visits (sessions that reached it), moved on (reached − stopped there) and CTR = moved on ÷ visits. Cards are taller (172px) to hold them. (43a)
- Funnel map link points (FlowLinkPoints.tsx): each card shows its ways out as dots on its end edge — the order form / checkout (completed_checkout), an offer's Yes / No, and every button with no link of its own (clicked_through + its element id, which the runtime already routes per button), or Continue when the page has none; at most five. Dragging a dot onto a card draws that path (replacing the dot's previous one), dropping it on the empty map or picking "A new step…" adds a step there; pressing a dot (Enter/Space) lists the steps instead of dragging. A button's path has priority 2 so it beats the step's general "always" path; connectors leave from their dot and are labelled with the button text. (43b)
- Funnel wizard (FunnelTemplateGallery.tsx): the starter templates can be filtered by kind (cash on delivery, with an upsell, leads, advertorial), switched between their Arabic and English versions and previewed page by page; "Your funnels" lists the store's own funnels (newest first) to start from a copy (POST /funnels/:id/duplicate, which now takes the chosen link). No "bought" tab, prices or usage counts: there is no template marketplace. Step 3 is "Name, link and currency": a currency other than the store's is saved as the funnel's own (settings.currency) for every way of creating it. (43c)
- Builder elements, first batch (pages/builderExtras.js, page-renderer/builderExtras.tsx, editor builderExtraBlocks.ts — registered like the showcase ones, PAGE_ELEMENT_TYPES untouched): `image_gallery` (own pictures, else the product's; thumbnails below or beside), `variant_selector` (option chips with stock and price), `bundle_selector` (the product's quantity offers), `review_form` (the shopper review form alone). An empty productId means the page's product. A pick on the variant or bundle picker is kept for the visit (sessionStorage) and announced on the page: the order form beside it follows it at once and the funnel checkout starts from the picked variant. Each draws nothing when there is nothing to show (no pictures, no options, fewer than two offers). (44a)
- Container and popup: the "container" is not a new element — every column is already a flex box, so it gains layout settings (items stacked or side by side and wrapping, the gap between them, how a side-by-side row lines up); nested element trees would have meant a second editor. `popup` is an element (builderExtras.js): any link or button to "#popup-<name>" opens it (caught before the link navigates), and "after N seconds" / "on leaving the page" open it once a visit; Escape, the × and the backdrop close it; in the editor preview it shows in place as a dashed card. (44b)
- Checkout elements of §9.3 are not separate blocks: `shipping_address`, `payment_form` and `order_bump` are the parts of `cod_form` (the product page's own buy box: options, the purchase form from Settings → Purchase form, payment methods, the store and product bumps) and, on a funnel checkout step, of the step's checkout form; `checkout_summary` and `order_summary` already exist. Splitting them would let a page hold an address with no form to send it, or a bump with nothing to add it to. `billing_address` has no use with cash on delivery, and `express_checkout` waits for a gateway that offers it (Paymob does not). Item 44 closes with 44a/44b.
- Funnel analytics: EPC = revenue ÷ sessions (base currency, minor units) beside the other totals; a "Page performance" table (analytics/funnelStepMetrics.js) per step: visits (sessions that reached it), page views (store analytics events, which now carry the step in metadata.stepKey — the funnel runtime puts the step in the tracking context), moved on and CTR = moved on ÷ visits, and CR = what the page is for ÷ visits: an order on a checkout or sales step (sessions that reached it and ordered), an accepted offer on an upsell/downsell (offer acceptances by step), a sign-up on an opt-in step (moving on from it submits the form), which is also its Opt-ins. Other steps show no CR.
- Product video: the media library accepts MP4 (an ISO ftyp box, QuickTime brands refused) and WebM (EBML) up to 30 MB, told apart by their bytes like images, counted against the plan's storage, and stored as uploaded (no transcoding on the server). A video lives in `product.media` with its video/* type: the pictures section shows and saves pictures only and carries the video back untouched, a "Video" card uploads/removes it (saved at once), and the product page plays it under the gallery (controls, inline, preload metadata, no autoplay). Picture helpers already skip non-image media, so no thumbnail ever points at a video.
- Theme catalog (migration 417, themes/themesCatalog.js): `themes` describes the themes the storefront draws (names, description, kind, category, tags, preview pictures, order, on/off, optional price set from the console — NULL = free, nothing in code) and `workspace_themes` records the themes a store used or owns (free | purchase). Seeded with the eight code themes, all free, so no store changes. The dashboard gallery reads it (order, names, All/Free/Paid and category filters, price on a paid card) and switches through it; a paid theme the store doesn't own can't be switched on — not by the gallery nor by a themeSettings PATCH (402 THEME_PURCHASE_UNAVAILABLE) — until the wallet exists; a withdrawn theme is 422. The original look stays free and on. (47a)
- Platform console → Themes (templates.view to see, templates.manage to edit): every catalog row with how many stores use it; edit names, descriptions, category, kind, tags, preview links, order, offered/hidden and price (empty = free). The original look can't be hidden or priced. New theme keys aren't created here — a theme is storefront code, so its row arrives with it (as the seed did). This closes the theme catalog part of item 28 too. (47b)
- Product-page A/B tests (migration 418, catalog/productTests.js): the split-test engine with subjectType `product_page`, subject = the product, one open test per product. Version A is the product as it is; B changes some variant prices and/or the pictures. A visitor is pinned the first time the product page asks (GET /store/:ws/products/:id/test, X-Visitor-Id — the tab's id, as funnels use). Only a running test changes anything and only for visitors it already assigned; paused = everyone sees A; picking a winner writes its prices and pictures into the product and ends the test (automatic winner as in funnels). Orders holding the product from an assigned visitor are credited to their version. (48a)
- The A/B price is the server's: `pinPrices` marks plain variant lines with a Symbol that `priceLine` reads, so no body can set it; offer lines keep the offer's price; funnels are left alone (they price their own way). The cart remembers who last added to it (carts.visitor_id) and is priced for them — on the cart, its quote and its checkout — so a cart filled in one tab costs the same in another; Buy Now, the quote and the coupon preview use the request's X-Visitor-Id, the abandoned checkout its visitorId. Product cards, JSON-LD and built landing pages keep the product's own price and pictures; only the product page's buy box and gallery show the version, and they wait for it (no flash of A). The staff's lost-order recovery prices at the product price. (48a, 48b)
- Dashboard: an A/B card on the product page — start (name, B share, B price per variant, B pictures picked or uploaded, optional automatic winner), results per version with confidence, pause/resume, delete, make winner (confirmed), finished tests listed. (48c)
- Custom code (§8.4) end to end: saved from Store settings → Custom code (website.publish, audited per slot), served by GET /store/:ws/custom-code (nothing to a staff preview). Head code is now in the server's first response: the storefront proxy names the store in `x-zimos-code` only on its own host, off /pay and /preview and without a staff token, and the root layout renders the head code as <meta>/<link>/<script>/<style>/<noscript> kept as written (lib/headCodeParse) plus the design stylesheet. Elements that don't belong in <head> or carry inline handlers/styles are still inserted by the browser, as before; the JS file and the UI blocks stay browser-side (they need the page). A page first loaded where code can't run (a payment page) adds all of it once the shopper moves on; the server stylesheet is switched off on such a page. Checked on demo-store.localhost: verification meta present once, head script run once, nothing on /pay or the internal /store/<id> path, no hydration warnings. (49)
- Front-end error reporting (§3.5, the part item 8 left open): packages/error-reporter in the frontend repo — console by default, Sentry when a DSN is set, sent as one envelope per error with no SDK so an app without a DSN carries nothing. The dashboard and the platform admin (VITE_SENTRY_DSN) send uncaught errors and unhandled rejections, the dashboard's route boundary what it catches; the storefront sends from instrumentation-client.ts (NEXT_PUBLIC_SENTRY_DSN) only errors from its own bundles — a merchant's custom code or an ad pixel failing is not a storefront bug — and its server errors from onRequestError (SENTRY_DSN). No user, cookies or bodies; addresses lose their query and hash (tokens ride there); at most 20 a page, the same error once. The marketing site is left out: it has no shopper or merchant flows. Checked against a local fake Sentry endpoint. (50)
- The old server-rendered store's checkout (POST /shop/:ws/checkout, quickstart/legacyCheckoutGuard.js) runs the storefront checkout's protection: the form carries the honeypot and time token for the same bot guard (a captcha store refuses there — the form can't show one); a store verifying every or every COD order refuses without sending a code the form couldn't take, pointing the shopper to the store; risky_only is left to createOrder as on the storefront; every refusal is filed as a lost order. The page itself stays: store hosts that reach the API still land on it. (51)
- The platform's WhatsApp number (notifications/platformWhatsapp.js, PLATFORM_WHATSAPP.md): `WHATSAPP_PROVIDER=cloud` sends ZIMOS's own codes through Meta's Cloud API as the approved authentication template (body + copy-code button; ar/en language codes from env), a ready text as text; anything else is refused so callers fall back. Phone number id `sandbox` answers locally (refused in production). `console` stays the development default but counts as not configured in production for WhatsApp and SMS alike — recorded as failed, so checkout OTP and phone checks fall back to SMS and sign-in codes to email, instead of "sending" into the log. Codes are redacted from production logs on every channel. (52)
- Phone masking reaches the lost-orders list and export and the suspicious-orders list (core/utils/phoneMask.forViewer, as orders and customers). Reaching the shopper stays possible for anyone with orders.view: the row's WhatsApp / Call ask POST checkout-sessions/:id/reveal-phone for the one number, audited as `lost_order.reveal_phone` — the same deal as opening an order page. Converting with the masked number left in the form uses the captured number. The suspicious list's masked number is plain text; the order page has the full one. (53)
- The payment link in messages (payments/paymentLinkToken.js): `{{payment_link}}` carries a signed token (`pl_` + an HMAC of store and order) that the shopper endpoints accept beside the shopper's own token — minting a fresh random token would break the page the shopper may still have open, and only its hash is kept. It opens /pay with the same actions (status, try again, switch to COD); whether the order can still be paid is the order's own window. The ready-made "payment failed" automation waits 20 minutes, not SPEC's one hour: the default payment window (PAYMENT_ATTEMPT_TTL_MINUTES) is 30, after which the order expires, the run stops, and the lost-order recovery takes over. (54)
- sitemap.xml leaves out hidden products (the same notHiddenSql the listings and the feed use); their link still opens. (55)
- Variant pre-selection: the store-wide switch (purchase form, `checkout_settings.auto_select_variant`) and the product's own page setting both have to allow it — either one off and the shopper picks every option first. A product can't switch it back on against the store; the store switch is the merchant's general rule. (56)
- The countdown element counts to a fixed date (pages/countdownDeadline.js): `endsAt` set in the editor (a date-and-time field), or `endsInHours` turned into a date the first time the page/funnel is published and written back into the draft, so republishing keeps it and every visitor sees the same deadline. Templates keep durations (stamped when a page made from one goes live). Only an unpublished draft's preview counts hours from now; pages published before this change get their date at their next publish (pre-launch, no live stores to migrate). (57)
- Funnels take the store's payment methods (§9.2, §11.4): the funnel checkout lists the funnel's own list (`payment-methods?funnelId=`, payment rules → methods per funnel) — COD, cards and wallets through the gateway, manual transfers and COD deposits with the receipt. A card/wallet order goes to the gateway; the payment page, once paid, offers "Continue" back to the funnel session (lib/payments savePaymentReturn), where the step moves on (the server already only advances paid online orders). A manual-transfer order advances like COD (the merchant checks the receipt later). A `cod_form` element on a funnel page draws the funnel's own form (lib/funnelSessionContext) and follows the step's "order" link; on a checkout step it draws nothing (the step has its form). The payment page now also recognizes the sandbox gateway's return fields. (58)
- The product page's own order form completes manual transfers and COD deposits like /checkout: the transfer details and receipt upload (components/checkout/TransferDetails), for the whole order (`bank_transfer`) or the deposit a COD order needs, refused client-side without the receipt and sent with the order. (59)
- Coupons in funnels (§9.3, §10.5): the funnel checkout has the code field (when the store allows codes) and picks up a `?coupon=` link (CouponFromLink now runs on funnel pages too); the code is previewed with the funnel (`coupon-preview` takes `funnelId`, so funnel-limited codes apply there and not in the store) and sent with the order only when it applies, as on the product page. (60)
- The store's currency (currencies/baseCurrency.js, §8.8/§11.5): set from Payments → Currencies until the first order (409 BASE_CURRENCY_LOCKED after); every variant and offer moves to it with the same amounts (a new store is still being set up — the merchant checks prices), it leaves the display list, audited. Prices created without a currency take the store's, not EGP. The currency format (symbol before/after, decimals) is applied by the storefront everywhere (lib/moneyFormat): client components get it from the store context, the page renderer's server elements from a per-request slot (React cache) the renderer fills — so server HTML and hydration agree. The new Saudi riyal sign (Unicode 17, U+20C1) is not used: common fonts don't draw it yet. (61)
- Pixel events (§13.2): the store product page sends ViewContent (once per view) and InitiateCheckout (the first time the shopper touches the order form); bundle adds were already AddToCart through the cart. Every event — in the store and funnels, browser side — names products by the product feed's item id (variant SKU, else variant id; lib/contentId) so catalogs match; Purchase reads it from the order lines' SKU snapshot. Events sent before the store's analytics context exists wait for it (up to 10) instead of being dropped. (62)
- 63: the checkout sends `adIds` (lib/adMatch.ts: _fbp/_fbc, _ttp, _scid, the _ga client id, click ids from the touch cookie, the visitor id), kept in orders.ad_match (migration 419) — the Purchase may go out days later (on_confirmed/on_delivered), so the ids are stored, not read at send time. marketing/pixelMatching.js builds the matching set: IP/UA from the order, fbc falls back to the attribution's fbclid, hashed fn/ln (first and last word of the name), ct, zp, country, external_id = hashed visitor id (same as the other server events) + customer id; contents use the feed's content id (SKU, else variant). TikTok gets ttp/ttclid/external_id/contents only — its name/address hashing rules could not be confirmed. GA4 uses the real _ga client id when present. Staff orders keep no ad ids.
- 64: automations/recoveryCoupon.js — the rule's couponCode rides on {{recovery_link}} as `?coupon=` only in messages that name {{coupon_code}} (so a first reminder does not give away the later message's discount); when no message names it, every link carries it. The /r/:token page prefers the link's coupon over the session's typed code; the checkout applies it through the existing coupon-from-link path.
- 65: "all filter results" ticks the ids (dashboard SelectAllMatching pages through GET /orders with the list's own query, up to 500) instead of sending `filter` to POST /orders/bulk, so printing, the extras and bulk shipping — which take ids — work on it too. Offered once the whole page is ticked and the list has more; the bar says when the 500 cap cut the list.
- 66: GET /orders/:id/session-details (orders/orderSessionDetails.js) — no new storage: the shopper is the visitor_id of the analytics event that carries the order id (else orders.ad_match.visitorId), pages are its page views up to a minute after the order (last 30). Order sequence counts the customer's non-test orders up to this one; "New customer" = one order in all. The last action is the newest timeline entry (status, audit, note, automation, webhook, courier) — shown in the header line, since PageHeader's description is text.
- 67: the draft is a JSONB on the order (orders.shipment_draft, migration 420), not a Shipment row with a 'draft' status — a shipment row drives the order's stage, counts and courier sync. Saving is allowed before the order can be booked (that is the point of preparing it); nothing is checked against the courier until booking. insertShipment clears it, so any shipment (form, bulk, auto-booking) ends the draft.
- 68: customer.updated / review.created / staff-edit order.item_added ride on the audit bridge (the audit rows already exist); a line appended to a placed order records order.item_added in addLineToOpenOrder. product.low_stock is a ProductVariant afterUpdate hook (registered by inventoryService) firing once per downward crossing of low_stock_threshold on available = on hand − reserved — every stock path uses instance updates. All four are webhook topics.
- 69: funnels hide the store footer, so the funnel layout's own footer gets the policy links (FunnelPolicies, new tab so the path stays put), and FunnelCheckout — which the COD form element reuses — shows PolicyLinks above its button like the store checkout. No backend change: `legal` already comes with GET /store/:ws.
- 70: category SEO uses the product's keys (title, description, imageUrl, noindex — validated with the same schema); the store's category address stays /products?collection=<slug> (its canonical), so that is what the sitemap lists, minus hidden and noindex categories. "Export" is one CSV of all categories from the page (per-row export of a single category made little sense); preview opens the category listing on the store's subdomain.
- 71: the primary domain counts only once verified and with its certificate issued (an https link to a domain without one would not open) — domains/primaryHost.js, cached a minute, cleared on domain changes. The redirect is 307, not 301/308: a browser keeps a permanent redirect for good and merchants change or drop domains; the canonical links carry the SEO signal. Skipped for staff previews, /pay and non-GET. resolve-host now also answers platform subdomains (primary host only), which the proxy asks once a minute per host.
- 72: no backend change — `general.country` already comes with GET /store/:ws. The forms' initial values carry the store country (lib/storeCountry), so every "EG" fallback became a fallback for an unset setting only; a hidden country field now sends the store's country rather than Egypt. Shipping quotes take the form's country (cart and bundle quotes the store's).
- 73: one image URL per variant (product_variants.image_url, migration 421), not a gallery per variant — the product keeps its gallery and the chosen variant's picture is put first. The product page's gallery and form are separate parts of the page, so the form publishes the chosen variant's picture through a tiny store (lib/variantImage, useSyncExternalStore). Option "image" swatches (§7.2 displayType) are left as they are.
- 74: three commits. Variant choice: only for a one-line offer (a bundle keeps its lines), any active variant of the offer's product at the offer price; priceLine now consumes the chosen variant's stock for a one-line offer (before, a line in another variant held the offer's variant). Countdown: offers.countdown_minutes (migration 422), from the session reaching the step (its updatedAt, untouched while it sits there) or the order's creation, 30 s grace, enforced by the server. Card orders: the thank-you offer becomes a linked order — one-click on a consented saved card, else COD — like the funnel's after an online payment.
- 75: the link change takes effect at once and the old /f/<old> stops answering (the funnel id link always works); no redirect history kept — the hint tells the merchant to update their ads. Funnel code follows the store's custom-code rule (own host only, never /pay or preview) and stays in place across steps (deferred removal, so a remount does not rerun scripts). The funnel's shipping group replaces every line's own group for orders and quotes in the funnel (calculateShippingAmount gets funnelId); the funnel checkout shows no quote, so the price shows on the order.
- 76: counted on the draft steps (what the merchant is editing), against the funnel's translations keyed by sentence hash — so an edited sentence counts as untranslated again, as on the Languages screen. One warning per step and language; nothing when the store has a single language.
- 77: impressions are a custom storefront event (`offer_view`, metadata { kind, id }, once per offer per page) — no new table. Acceptances/revenue come from what is already stored: bump lines by the rule's offer, upsell_acceptances by rule, orders whose discounts_snapshot carries the bundle, exit-code redemptions. Cross-sell has no revenue figure: an item added from the strip is not marked on the order, so only adds to cart from the rule's strip are counted.
The photos are uploaded through the media library and only their URLs are sent (max 6). The provider gets them as `images` with prompt `product_content.v2`, which states the photo count and says to describe only what they show. The sandbox provider ignores them. Existing v1 jobs keep their prompt version.
A product on a plan is sold only for a card on a gateway with `supportsTokenization`. The checkout, a payment retry and a switch to cash on delivery answer 422 `PLAN_NEEDS_SAVED_CARD` otherwise. The card is saved without a separate tick, because the storefront says so beside the methods; `startForOrder` saves it, so the shopper's own `saveCard` is ignored for such an order and the card is not saved twice. The storefront filters to card methods. With none, it leaves the list and says the product can't be ordered. The installments note shows each payment (the variant price) and the total (price × payments).
Saving a card with no payment is an optional gateway contract (`createCardSetup`/`completeCardSetup`); the sandbox implements it, and real gateways add it later. The portal uses the gateway of the card on file, else the one the first order was paid with, else the first live one. A test gateway is never picked for a live shopper. A card update on a past-due subscription charges the renewal at once and resets the retry count. A trial prices the product line at 0 on the first order through the server-pinned price `priceLine` already honours (`Symbol.for('zimos.productTestPrice')`), once per phone and product. With nothing else to pay, the payment becomes a 0 "payment" whose redirect is the card page; on return the order is paid at 0 and completed. The order summaries still show the regular price, and the payment note says the trial takes it off. "Renewal failed" is a ready automation template (WhatsApp + email with `{{payment_link}}`, the portal).
`ad_id` from the landing URL is kept in the order's touch (`adId`). Spend is still kept per campaign per day; an ad-level CSV (with an "Ad ID" column) is added up into those rows and keeps the ads' ids. An order is counted under a campaign by its `utm_campaign` (name or id) first, then by the campaign its ad belongs to. That rescues renamed campaigns and unfilled `{{campaign.name}}` templates. Ad ids are matched whatever the day they were imported on. Manual spend entry has no ad ids. The P&L by campaign still groups by `utm_campaign` only.
Both are `standard` apps (on until uninstalled), like the other features stores already had, so no store loses its feed or Clarity script. Uninstalling Google Merchant makes only the `google` feed channel answer 404; the Meta, TikTok and Snapchat feeds stay. Uninstalling Clarity removes Clarity pixels from the storefront payload; the other pixels stay under Tracking tools. "Open" goes to /offers/feed and /marketing. No frontend change was needed: the apps page renders from the catalogue.
The email changes only when the link sent to the new address is opened (24 hours, single use), and that counts as verifying it. The old address is told at the request and at the change. The password is asked for when the account has one; a Google-only account relies on its session. A wrong password answers 400 `INVALID_PASSWORD`, not 401, because the dashboard reads 401 as an expired session. Pending changes are their own table (`email_changes`), not a new `verification_tokens` enum value. Other sessions are not signed out.
The links are a platform setting (`platform_settings.education_links`), not code, because the URLs are ZIMOS's own and change. The console page uses the announcements permissions. Ten dashboard topics each have one tutorial link, shown under the page title through a `tutorial` prop on PageHeader. The help center, Telegram and support chat are cards at the bottom of the home page. Anything unset is not shown, so nothing appears until the platform team fills it in.
Templates are synced into `whatsapp_templates` (one row per name + language). This happens on demand, after connecting, and through Meta's status webhook; there is no cron. Syncing a real number needs the WhatsApp Business Account ID; the sandbox number returns a fixed list. Sends are only refused for a template the list knows that is not APPROVED; an unknown name still goes to Meta, since the list may not be synced yet. The pickers sit above the existing name field, which stays for templates not synced. Picking a template sets the language and the number of variables.
Frontend only: the backend already applied `productIds` and `funnelIds`. The pickers are searchable checkbox lists. Products are loaded up to 300 (three pages, active and draft); the product list API has no name search, so the search filters on the client. Ids of deleted products or funnels stay on the rule until cleared, and the editor shows how many there are.
The sender name defaults to the store's name; the merchant may set another (no quotes or angle brackets, at most 70 characters). The Reply-To is empty unless set, because the owner's own email is not handed to customers by default. The sending address stays the platform's; verifying a merchant domain (SPF/DKIM) is still out of scope. Both values go into the email's data, so the console provider logs them and Brevo gets `replyTo`.
The teammate's WhatsApp goes out from the platform's own number, not the store's: a store may have no WhatsApp at all, and the store's number talks to customers. It is sent only to a verified phone, as an approved utility template (`WHATSAPP_ALERT_TEMPLATE`, default `zimos_alert`, three parameters: title, text, dashboard link), because Meta does not deliver free text outside a 24-hour window. It is off by default for every type. It has no SMS fallback, because the notification is also in the bell.
`valu` and `kiosk` are real order payment methods: new enum values, named once in `payments/methodNames.js`. They are not card or wallet in disguise, so reports and rules can tell them apart. Paymob has one integration id per method. A kiosk order holds its stock for 48 hours (`PAYMENT_KIOSK_TTL_MINUTES`), because the cash reference is paid later. One-click upsells after a paid order remain card and wallet only. Staff manual orders do not offer them.
With the store's WhatsApp connected, the row action sends the `cart_reminder` template (the same one as the ready abandoned-cart automation) from the store's number. Its variables are filled in a fixed order: name, store, recovery link, total, products, as many as the synced template has, or 3 when it was never synced. A phone that answered STOP or is blocked is refused like any marketing message. The message is logged in the inbox, and the lost order is marked contacted on the server. Without a connected number, the action still opens wa.me as before.
French is a full storefront dictionary (`lib/i18nFr.ts`, every key, checked by the `Dictionary` type). The store opens in French when its default language is French. The switch adds French only when the store offers it (dashboard → Languages, the existing `store_languages`), so Arabic/English stores are unchanged. About a dozen components carry their own short ar/en strings; in French they show English (`pickText`). Governorates and merchant-written field labels are kept in Arabic and English only, so French shows the English versions.
The tree holds only `html_block {blockId}`, and the tree validator checks the id's format. The HTML is a custom-code row (`hb:<id>`) with the custom-code rules: `website.publish`, audited, served with the page or step that places it, never in a staff preview, and run only on the store's own host. A new element gets its id when its code is first saved, so an unsaved block is valid and shows nothing. Saving takes effect at once, outside publishing, like page scripts. A duplicated element shares its block, so editing one changes both. A block whose element is gone is never served.
New: `masonry_grid` (pictures with captions and links in 2–5 CSS columns). A button gets an `action`: link (the default), `add_to_cart` (opens the cart) or `buy_now` (adds the item and goes to checkout). Its variant is the one picked on the page, else `variantId`, else the first variant in stock. In a funnel a button keeps the funnel's own flow.

The price element follows the variant picked on the page (`lib/pagePicks`); every variant's price is formatted on the server, so the client only swaps the text.

"Sticky container" is a column setting (`sticky: top | header`). It applies from `md` up only, because columns stack on phones.

Forms get one stars input (`ratingLabel`, 1–5, checked on the server) and one photo input (`fileLabel`, `fileRequired`). The photo uses the existing customer upload path, which takes JPEG, PNG or WebP only and re-encodes them. Other file types are not taken because they have no safe re-encoding step.

The upload must belong to the same visitor (`visitorId` in the body). Submitting attaches it, so it stops expiring, and stores it as `data._files`. Staff see it through a signed link, and deleting the submission deletes the photo. Which inputs a form has is always read from the published page.
Frontend only: the backend and storefront already read a step tree's `productId` and `globalStyles`. The funnel step page editor reuses the website editor's components unchanged: `LayerList` (with "add here" slots), `ResizableSplit`, `PageProductField`, `SavedSectionsLibrary` and `SectionInspector` with named styles.

Undo/redo lives in a new per-step hook (`funnels/useStepHistory.ts`). It uses the website editor's limits and the same typing fold, and opening another step starts a fresh history.

The tree itself stays in the funnel draft, so edits are still saved by the funnel's one Save button.
Frontend only. Duplicating a section or an element copies it with new ids, right after the original. Its look and any saved-section link come along. A copied HTML block shares its code, as decided for item 92.

Double-click editing works on the plain text a renderer shows unchanged: heading and text use `text`, a button uses `label`, a link uses `text`. The editor sends the frame the ids it may edit (`inlineText`), leaving out any text bound to live data.

The frame edits in place with `contenteditable=plaintext-only`. Enter commits a one-line text, Escape restores it, and leaving the element commits. The commit posts `zimos:edit-text`, and the editor turns it into one undoable tree edit.

X-ray is a preview toolbar switch that injects outlines for sections, rows, columns and elements into the frame. The funnel step editor's preview now uses the same canvas, so it gets these tools along with picking, inserting, dragging and resizing.

Scratch env: the dashboard dev server now gets `VITE_STOREFRONT_URL`, so the canvas loads.
A generic page is a `custom` step that no edge touches. It needs no new column or migration, and a `custom` step joined to the map stays an ordinary step.

The backend (`funnels/genericPages.js`) and the editor (`genericPageRules.ts`) leave generic pages out of the entry and "unreachable" checks. Every step counts when all of them are generic, so a one-page funnel still works.

Public pages are served at `GET /store/:ws/funnels/:ref/pages[/:key]` from the published revision, localized and with their scripts and HTML blocks. A step on the path is refused (404), because those are reached through a session.

The storefront shows a generic page at `/f/<funnel>/p/<key>`, inside the funnel's masthead and footer, with a link back to the offer and to the other generic pages.

The editor lists generic pages in the map's sidebar with presets (contact with a form, about, policies, blank), each keyed by its name so the address reads well. They do not appear on the map or in the step list.
The four P2 features use the existing AI job pipeline (`ai/featuresP2.js`), and no new tables were needed.

- **Page review.** The facts are measured on the server (`ai/pageFacts.js`): where the order form and calls to action sit, the price, pictures and their descriptions, social proof, FAQ, guarantee wording and countdown. Alongside them go 30 days of numbers from the store's own analytics (page views, visitors, orders from visitors who landed there, or the funnel step's views). The provider scores from those facts; the sandbox scores by fixed rules.
- **Ad creatives.** These are texts plus banner specs (headline, subline, badge, format) laid over the product's own pictures. Any banner on another address is dropped. The dashboard draws previews and offers a PNG download at the platform's size. Producing raster images would need an image provider, which is left to the integrations team.
- **Store builder.** Apply creates an unpublished page and hidden collections. The suggested theme (free themes only) and the policies are shown for the merchant to switch on or copy. Nothing goes live.
- **Suggested WhatsApp replies.** These use the bot's own facts (store info, products, the customer's orders) and fill the inbox's message box; a person sends it. The feature is gated on `orders.confirm`, and a user with only inbox access can read only `wa_reply` jobs.
Storage gains a multipart contract (`media/storage/MULTIPART.md`):

- **R2.** `r2Multipart.js` uses a SigV4 query presigner written in-house (`s3Presign.js`), so no new package is added. Its signatures match `@smithy/signature-v4` exactly on test inputs.
- **Sandbox.** `localMultipart.js` keeps signed, expiring `/storage-sandbox` routes that write parts and join them on complete. These routes are only mounted with local storage outside production.

`digital/multipartUploads.js` handles the upload itself:

- Files go up to 10 GB, in 64 MB parts.
- The plan's `storage_bytes` room counts the declared size up front, including uploads still in progress.
- Completing needs every part exactly once, and the stored size must match the declared one.
- An upload abandoned for a day is aborted the next time the store starts one.
- In-progress uploads live in `digital_uploads` (migration 428).

Files above 100 MB download through a 5-minute signed storage link (302) instead of streaming through the API. The download is still counted against the grant first.

The dashboard uploads in parts above the single-upload limit, three parts at a time, retrying each part twice, and shows progress with a Cancel button.

R2 CORS must expose `ETag`; the README documents this. The sandbox also returns the ETag in its JSON body.
Removed from the storefront:

- the parked `UpsellOfferView`, which invented a 25%-off offer on the device and recorded acceptance only in `localStorage`;
- its `lib/commerce.ts` helpers (`getUpsellOffer`, `acceptUpsell`, `getAcceptedUpsell`);
- the thank-you page banner and footnote that read that local acceptance;
- the strings no longer used, in English, Arabic and French. `upsell.save` stays because funnel offers use it.

`/offer/<order>` stays as a redirect to the thank-you page so old links keep working. The real post-purchase offers are `ThankYouUpsell` (Offers → post-purchase upsell) and the funnels' upsell/downsell steps. The backend had nothing to remove.
**Reset.** `POST /themes/current/reset` (`themes/themeReset.js`, permission website.edit) removes only the look keys the merchant tuned on top of the theme: `primaryColor`, `primaryColorSource`, `primaryColorDark`, `secondaryColor`, `fontFamily` and `cornerRadius`.

- It keeps the theme itself, the logo, and the content of the header, footer and announcement bar.
- It takes effect live at once, like switching a theme, and is audited with the before-state.
- The gallery shows Reset only on the current theme's card, behind a confirmation.

**Tags.** Migration 429 seeds tags for the seeded themes from a small shared vocabulary that the dashboard translates. Only empty tag lists are filled, so console edits are never overwritten; the console already edits tags. Each card shows its tags, and a Style filter lists every tag in use.
Contact details are each store's own settings: Store info (email, phone, address), Social links and the floating WhatsApp, all already editable in the dashboard. The rich footer and the theme's floating corner now read them from there and no longer from `themeSettings.footer.contact/social` or `floating.whatsapp`, which only templates ever wrote. So no new editor was needed.

Migration 430 removes Uokids' values from the template and from any store holding them exactly. A store that is Uokids itself (by name or slug) gets them moved into its own empty settings instead. The template data file no longer seeds them.

The template's demo pictures still come from uokids.com's CDN. That is sample content, not contact data, and is left as it is.
Order exports (CSV, Excel, background) mask every phone field at any depth with the orders list's own `maskPhonesDeep` unless the teammate has `customers.reveal_sensitive`.

- A background export decides this from who started it and stores it on the export. One started before this change is masked.
- The audit row records `maskedPhones`.
- The export dialog says it, since the dashboard keeps no permission list to show it only to masked roles.
- The shipping manifest and waybills keep full numbers: the courier needs them, and they are behind `shipping.manage`.
The checkout autosave (`POST /store/:ws/checkout-sessions`) passes the order's bot guard (`checkoutSessions/autosaveGuard.js`), and every save keeps the shopper's IP and its country on the session.

- Guard checks: the honeypot, a valid time token, and the token at least `MIN_SECONDS` old. There is no challenge: that token is spent on the order.
- A refusal is quiet. The reply carries a random session id, so a script can't tell it was dropped. The order path treats an unknown id as no session.
- The storefront waits out a fresh token before it saves (`botGuardAutosaveFields`), so a fast typist is never caught.
- A later save from another address replaces the IP and country together. A save with no known address keeps the ones already stored.
"Switch to cash on delivery" on the pay page meets what a COD checkout meets (`payments/codSwitchChecks.js`), after the platform blocklist and the refusing flags it already checked.

- **Funnel payment methods:** a funnel whose list leaves out COD can't switch, and `canSwitchToCod` is false there.
- **Per-IP rule:** `min_minutes_between_cod_orders_per_ip` runs on the order's IP while the protection app is on, and its action applies:
  - flag: the order gets `ip_order_rate`.
  - block / to_lost: generic ORDER_REJECTED with an `order.blocked` audit, and the order stays awaiting its payment.
  - require_otp: a code is asked.
- **Code by phone:** asked for `cod_only`, for `risky_only` on a risky order, and when a `require_otp` rule flagged the order. Online checkout only flags those orders.
  - `all` was already asked at checkout, so the switch does not ask again.
  - The pay page takes the code inline: the order's phone is never shown, only its hint.
  - The code is sent with the switch (`otpCode`); the same call without it sends another code.
  - The code is checked last, so a deposit error does not spend it.
- **Deposit:** the shopper's payment status names the deposit up front (`codDeposit`). The pay page shows the transfer form once the shopper picks cash on delivery. The transfer is recorded as a `deposit` payment in the switch's transaction, on the order's COD price.
The abandoned-cart email is marketing, so `automations/marketingGuard.js` checks it like the WhatsApp recovery message. It is not sent to:

- a phone that replied STOP
- a blocked phone
- a blacklisted customer
- an unsubscribed email
- a blocked email

The email ends with an unsubscribe link, which is the email form of STOP (`notifications/marketingUnsubscribe.js`, storefront `/unsubscribe`):

- The link is signed and names the checkout it was sent for, so it can't be forged for someone else.
- The page asks for one click instead of acting on open, because mail scanners open links too.
- One unsubscribe covers both channels: it records the checkout's email and its phone (when it had one), exactly as a WhatsApp STOP stops all marketing.
- A newsletter sign-up opts the person back in, by phone and by email.

Migration 431 lets `marketing_opt_outs` hold an email, with or without a phone.

Automation email steps on marketing triggers now pass the subject's email to the guard as well. No List-Unsubscribe header: the email provider wrapper takes no custom headers.
Ending a session now cuts its access token at once, not when the token runs out (up to 15 minutes later). The access token carries its session (`sid`), and every authenticated request checks it with `core/security/sessionGate.js`. This covers:

- ending one device
- ending all devices
- a password reset (link or SMS)
- a replayed refresh token

How the check works:

- A refreshed session is followed along its `rotated_to_session_id` chain in one recursive query, so a request in flight during a refresh is not thrown out.
- Answers are cached for 10 s. Any change to a session row empties this server's cache, so the cut is immediate here and within 10 s on other servers.
- Tokens issued before this change (no `sid`) still work until they expire.
- The answer is 401 `SESSION_ENDED`. The dashboard's refresh then fails and it goes to the login page, with no frontend change.

The inbox and live-analytics streams: their tickets carry the session. An ended session can't open a stream, and an open stream is closed within 15 s.
Two-step sign-in recovery (`auth/twoFactorRecovery.js`, migration 432).

**Backup codes**
- Ten one-time codes, made from Settings → Security after the password and shown once. Only hashes are kept, and making new codes voids the old ones.
- A code works in the sign-in step in place of any channel's code. Using one emails the person: a new `security_notice` email that says how many codes are left.
- The sign-in step starts in backup-code mode when no code could be sent. That happens after five codes in ten minutes: login used to refuse with TOO_MANY_CODES, so a person locked out of the phone or mailbox could never reach a step to type a backup code. Now login opens the step without a new code (`codeNotSent`).

**Platform reset**
- In the console, a platform user with `support.manage` turns the second step off from the user page. It is meant for someone who lost every way through, after support checks who they are.
- The reset ends every session, forgets remembered browsers, records `admin.user_two_factor_reset`, and emails the person.

**Password reset**
- A password reset (link or SMS) keeps two-step sign-in on. Otherwise a mailbox that can reset the password would also get past an authenticator.
- It now forgets remembered browsers, so every device asks for the second step again.
**Sign-in from a new device** (`auth/newDeviceSignIn.js`)

- A password sign-in from a browser that has never signed in to the account is asked for an email code. It goes through the two-step challenge (`challengeIfNeeded` with `newDevice`), and the answer carries `newDevice: true`.
- An account with two-step sign-in on gets its own second step instead.
- On in production. Elsewhere `NEW_DEVICE_CODE=on` turns it on, so local scripts that sign in with curl keep working.
- Google sign-in skips the code, as it skips two-step: Google ran its own check.

**New sign-in alert**

- Whenever a sign-in finishes on a browser new to the account, the person gets an email naming the browser, the IP and the time, and what to do if it wasn't them (`security_notice` / `new_sign_in`).
- Sign-up and its confirmation remember the browser without an alert.

**Remembering a browser**

- A "known" browser is a signed, httpOnly cookie listing up to five accounts that finished a sign-in there.
- It only spares the code and the alert. It is not the two-step "remember this device", which skips the second step and is kept server-side.

**Fix along the way:** the platform console's login could not take a code at all (it read `result.user` from a challenge), so a platform user with two-step sign-in could not sign in. The console now has its own code step, with backup codes.
Two places where a countdown could go live still counting "N hours from now" for each visitor now get a fixed date like every published page (`pages/countdownDeadline.js`).

**Split-test variant pages** (`funnels/splitTestCountdowns.js`)
- A variant goes live while its test runs on a published funnel, without a publish of its own.
- Its countdowns get their date when the test is created or changed on a live funnel, and when the funnel is published with the test running or paused.
- A test on a draft funnel keeps its durations until the funnel goes live.

**Linked saved sections**
- A website publish freezes linked sections with the saved section's content. That content's countdowns are now dated in the saved section itself, so every page linking it and every later publish show the same deadline.
The opt-in step collects the visitor's details before the funnel moves on (`funnels/funnelOptIn.js`, migration 433).

**What gets saved**
- The form asks for a name and a mobile or an email.
- The sign-up is kept like a page form's: a form submission named after the funnel and step, plus a contact when it carries a phone.
- The contact is tagged `opt_in`, has source `funnel`, and gets marketing consent. The form says so beside its button, along with how to STOP.
- A sign-up clears an earlier STOP.
- A new phone is a lead (`lead.created` with the funnel, inside the plan's leads limit).
- The checkout's bot guard applies, and a bot is answered without anything being kept.

**Effects on the funnel**
- The session keeps the sign-up under the step (`opt_ins`).
- Advancing from an opt-in step without one is refused with `OPT_IN_REQUIRED`.
- The page's own "next" buttons bring the visitor to the form instead of skipping it.
- The step's Opt-ins count (and its conversion rate) is stored sign-ups, not every move past the step.
- The ad platforms' Lead fires only after a stored sign-up.
Linked saved sections now work inside funnels as they do on the website.

**Funnel publish**
- A funnel publish fills each step's linked sections from the saved section's current content (with countdown dates fixed), so editing a saved section and publishing the funnel updates every linked copy.
- The pages of running split tests get the same treatment. A variant page is both what the editor holds and what visitors see, and it keeps its links.

**Funnel-only saved sections** (the backend already had `scope: 'funnel'`; nothing used it)
- The funnel editor's library lists the store's sections plus that funnel's own, marked "This funnel".
- Saving a section there can be "Only in this funnel".
- A funnel-only section fills links inside its own funnel only. A website page or another funnel linking it keeps its own copy, and a website publish now resolves global sections only.
A paid order's subscription and course enrolment now start from the `order.paid` outbox event (consumers `subscriptions_start` and `courses_enroll` on the `default` queue), not from an after-commit call that nothing recorded.

- The event is written in the payment's own transaction.
- A failed attempt is retried by the queue, and a worker that dies mid-job has its job picked up again after the stale-lock timeout (10 minutes).
- Both are safe to repeat: a line's subscription is unique per order line, and an existing enrolment is not made twice.
- `startForOrder` and `enrollForOrder` still never throw for other callers. The consumers ask them to re-throw so the queue sees the failure.
- Verified by killing the server right after a payment: the subscription and enrolment were made after restart.
`remove_branding` (from the plan or an override) now takes ZIMOS off every surface of the store, not only the classic footer:

- the rich footer
- the funnel pages' footer
- the store and funnel headers, which showed the ZIMOS logo in place of a store logo when the store had none (they show just the store's name)

One helper (`brandingRemoved`) reads the store's `removeBranding`. The store-unavailable page keeps its mark: it gets no plan information, and the store isn't open anyway.
The storefront no longer makes up promises for a store. "Fast delivery", "Easy returns", "within 2–5 working days", "we'll arrange an exchange" and "we call before we ship" are gone. Every such promise is now the store's own shipping, returns and cash-on-delivery cards (Settings → store info, `lib/storePromises.ts`):

- **Trust strip** (home, cart): the cards; no row when there are none.
- **Product page:**
  - The "Shipping & returns" tab shows the shipping and returns cards, and is left out when the store has none.
  - The FAQ is the product's own questions. Failing those, it is the store-wide questions answered from the cards (how to pay → COD card, when it arrives → shipping card, returns → returns card), and a question with no card is left out.
  - The aside shows the cards, with no generic row in their place.
- **Footer help column:** the cards' titles, hidden when there are none.

A card with no title is named by its kind ("Shipping", "Returns", "Cash on delivery").
The rich footer now adds the same columns as the plain footer: the pages flagged "show in footer" and the store's written policies. The plain footer's code moved into `lib/footerLinks.ts` and both footers use it, so choosing a footer layout no longer drops a store's policy links (which ad platforms require).

The social accounts already came from the store's Social links (item 101). They now also show in the bottom row when the merchant turns the brand block off, where they used to vanish with it.
Automation conditions now apply on the triggers that carry no order (`automations/subjectConditions.js`). Before, a rule on `checkout.abandoned`, `lost_order.created`, `lead.created` or `subscription.renewal_failed` ignored its conditions and ran for everyone.

Each condition reads what the subject has:
- **Lost or abandoned checkout:**
  - its lines (products, subtotal)
  - the address typed (governorates)
  - store or funnel (source)
  - the refused checkout's payment method and funnel
- **Lead:** whether it came from a funnel.
- **Subscription:** its product and the period's amount. The payment method is a card, since renewals charge a saved card.
- **All of them:** tags and "first order" are read from the contact. A checkout counts as risk "low", since it isn't scored.

A condition the subject can't answer (a lead has no products; a checkout autosaved before a payment method was picked) skips the rule with that reason, rather than sending something the merchant limited to something else.
Subscriptions on a free trial (`trialing`, from trialCheckout.js) now show on the subscriptions screen:

- an "On a free trial" count beside the others
- a "Trial" option in the status filter (the API refused `status=trialing` before)
- included in the top products

They are not in the "per period" amount: nothing has been charged for them yet.
"Convert to order" on a lost order:

- **Can't create two orders.** The session is claimed by one conditional update (status → converted) before the order is created. A second click, or a second teammate, gets 409 `CHECKOUT_SESSION_CONVERTED`. If the order can't be made, the claim is released and the lost order is left as it was.
- **Keeps the coupon.** The shopper's code is used, and the body's `discountCode` may replace it or drop it (null). An invalid code fails the conversion with the discount error rather than converting silently without it.
- **Keeps the funnel.** The order carries `funnelId`. Its source stays `manual`.
- **Keeps the custom answers.**
  - A refused checkout now stores each line's custom-field answers, including lines added beside a "Buy now", which were dropped before.
  - It also stores the checkout form's extra answers. Both go onto the converted order (the shopper's photos are checked against their visitor id).
  - Lines the merchant edited in the convert dialog use what the dialog sends.
**Recovery messages mark the lost order contacted**
- A recovery automation's message (WhatsApp, SMS, email) that goes out marks the lost order "contacted", as the manual WhatsApp button does (`automations/recoveryContacted.js`).
- Only an order nobody has dealt with yet: a merchant's "recovered" or "lost" stays.
- The sequence's stop check treats contacted like not contacted, so the next reminder still goes. A merchant's recovered or lost still stops it.

**The ready-made abandoned-cart recovery follows SPEC §6.4**
- Timing: a reminder after about 30 minutes, then a last one after 24 hours. The checkout counts as abandoned after 15 minutes by default, so the template waits 15 more.
- Coupon: given when switching it on (an optional field on the template card), the last reminder becomes `cart_reminder_coupon`, which offers the code, and only that message's link applies it.
- Without a coupon, the last reminder stays the plain one. A WhatsApp template can't carry an empty coupon parameter.
The order tracking page checks the phone the way the store's checkout does, by the store's country (`general.country`):

- in Egypt, an Egyptian mobile
- elsewhere, a full number of 8–15 digits, with the matching error message

The Egyptian placeholder shows only in Egypt. The number goes to the API as digits only (a "+" used to be refused there), and the server normalizes it as it did at checkout. Applying the store's country on the server is the next item (121).
The server now reads the store's country (`core/utils/storeCountry.js`): `settings.general.country`, else the region of the store's language, else Egypt.

- **Phone numbers:** a local number ("05…", "01…") is read in the store's country. The storefront's `resolvePublicWorkspace` and the dashboard's `resolveTenant` put the country on the request context, and `normalizePhone` takes its calling code from it, so every caller (checkout, customers, lost orders, tracking, OTP, blocklists) follows without being edited.
- **Outside a store's request** (queue jobs): numbers are already stored with their country code, and the Egyptian default stays.
- **Normalizer guard:** an 11-digit number that already starts with a known country code (Kuwait, Qatar, Bahrain, Oman: "965…") is no longer read as a bare Egyptian number.
- **Risk score, phone rule and allowed countries:** `fraudRules.storeCountry` now reads the same setting. It used the language only, so an Arabic store set to Saudi Arabia was treated as Egyptian. The order's risk score now loads the setting too.
- The country codes moved from `fraudRules` into the new module.
- Existing customers in a non-Egyptian store whose local numbers were stored with +20 are not migrated: pre-launch, there are no live stores.
Collection follows the order's currency (SPEC §11.5). Prices are still never converted.

- **Payment methods:** a gateway shows only when its adapter takes the checkout's currency (`payments/methodCurrency.js`).
  - The currency comes from the storefront (the cart's), else the funnel's, else the store's.
  - Cash on delivery and manual transfers take any currency.
  - An online checkout whose gateway cannot take the order's currency is refused (`PAYMENT_CURRENCY_UNSUPPORTED`) before the order is created. Before this, the order was created and its payment then failed.
  - The pay page and retry list only the methods that take the order's currency.
- **Payment fees:** a percentage applies in every currency. A fixed amount is money in one currency (the store's when unset) and applies only to orders in it.
  - Each method can have one percentage and one fixed amount per currency. An order takes the fixed amount in its own currency, else the percentage.
  - The storefront note now shows a fixed fee in its own currency; it always printed EGP before.
- **Shipping groups:** each group has a currency (migration 434; null = the store's).
  - A group in another currency is for funnels that sell in that currency, and it holds no products (`SHIPPING_GROUP_CURRENCY`).
- **A funnel selling in a currency other than the store's:**
  - Only its own group prices its shipping. The store's rates, default rate and threshold are in the store's currency and do not apply to it.
  - The extra shipping options (express, pickup) are in the store's currency, so they are not offered.
  - Its free-shipping threshold is its own setting (`freeShippingThresholdAmount`, in its currency); blank means no free shipping.
  - It publishes only with a group in its currency that has a price for everywhere.
  - A group in a currency other than the funnel's is ignored at pricing time and refused at publish.
- **A funnel selling in the store's currency:** its own threshold applies when set, else the store's.
- Editing an order's items now reprices shipping with its funnel, the same way placing the order does.
Shipping is priced by the platform's places (`geo_regions`; new `shipping/shippingPlaces.js`): Egypt's 27 governorates plus North Coast, and Saudi Arabia's 13 regions.

- **Prices:** `shipping_governorate_rates` keeps its name. It now takes any place code (`north-coast`, `sa-riyadh`, …), and unknown codes are refused by the service.
  - An address is read back to its place from its province: Egypt's 27 straight away, anything else through `geoRegions.resolve`. So "الرياض", "Riyadh Region" and the storefront's "<ar> (<en>)" all price the same.
  - The rate is no longer limited to Egypt.
  - Shipping groups price by the same place codes.
- **North Coast** is its own place in the checkout's list, as EasyOrders has it. Before, a North Coast order was priced as Alexandria or Matrouh.
- **Hiding a place** (`shipping_hidden_places`):
  - The storefront leaves it out of the checkout's and the cart's list; the public store carries `hiddenPlaces`.
  - A shopper's checkout to it is refused (`SHIPPING_PLACE_UNAVAILABLE`).
  - Staff orders are not checked, since the merchant may still deliver there by hand.
- **One price for all:** a dashboard action that fills every place's price. The merchant can still change any of them before saving; nothing new is stored.
- **The dashboard table** lists the store's country's places (`GET /shipping/settings` adds `country`, and `governorates` comes from the platform's list). A Saudi store sees "Price per region".
- **Storefront:**
  - Egypt's list gains North Coast, and Saudi stores get a select of their regions instead of free text (`lib/places.ts`, the same codes and names as `geo_regions`).
  - Other countries keep free text.
  - The ship-to picker in the cart shows only for countries with a list; it showed Egypt's list to every store before.
- Districts under a city (SPEC "areas", optional) are not priced separately yet: the cities exist in `geo_regions`, but the form takes the city as free text.
Root domains and www (SPEC §8.11, new `domains/rootDomains.js`).

- **A root domain** (example.com, example.com.eg — the second-level suffixes such as com.eg and co.uk are recognised) cannot take a CNAME.
  - It is given A records to the platform's edge addresses (`PLATFORM_APEX_IPS`, comma-separated, set per deployment and documented in `.env.example`). An ALIAS / ANAME / flattened CNAME to the store's platform subdomain is offered as the alternative.
  - Without `PLATFORM_APEX_IPS` only the ALIAS is offered. No addresses are written in code.
  - A subdomain keeps its CNAME.
- **www and the root are one address.** A root domain or its www can have the other one (its "counterpart") sent to it: `domains.counterpart`, migration 435.
  - It is on by default when the domain is added, unless the counterpart is connected itself.
  - `resolve-host` answers the counterpart with `redirectTo`, and the storefront proxy sends the visitor there (straight to the primary domain when there is one), same path and query, with a 307 like the existing primary-domain redirect.
  - A counterpart verified as a domain of its own is served as itself. A pending one (someone else's) does not block the redirect.
- **Certificates:** the counterpart has its own request through the certificate provider, beside the domain's own check. A provider failure for it never fails the domain's check. Turning the redirect off, or deleting the domain, revokes it (`certificates/README.md` step 4).
- **The DNS check** reports the routing record whichever kind it is. A root counts as reaching the store when its addresses are the platform's or those of the platform subdomain, which covers an ALIAS. The counterpart is checked too.
- **The dashboard** lists the A records and the ALIAS alternative, explains why a root takes no CNAME, and has a switch "Send www.<domain> here too" with that certificate's status.
- `NO_COUNTERPART` (422) for a subdomain that is not www; `COUNTERPART_CONNECTED` (409) when the counterpart is verified as a domain of its own.
Each product feed item now links to its own variant (SPEC §7.8: the item `id` is the variant).

- **The feed** (`offers/productFeed.js`): for a product with more than one active variant, the link is `/products/<slug>?variant=<variant id>`. A product with a single variant keeps its plain link.
- **The product page** (`ProductLanding`) opens on the variant the link names. The price, picture and availability the shopper sees are the ones the ad showed: Google Merchant refuses items whose landing page shows another variant's price.
  - The link wins over the page's own remembered pick.
  - Without the parameter, the first variant in stock as before.
- **ViewContent** is reported with that variant's id (its SKU, else its id — the same id the feed item has), so catalog ads match the visit to the item.
- The canonical link stays the product's plain URL, so search engines still see one page per product.
A funnel's sales page with an order form (a `cod_form` element) now has order bumps (SPEC §9.5, §10.3).

- **The step's own bump:** a sales step can carry `bumpOfferId`, as a checkout step already could (`orderBump.BUMP_STEP_TYPES`: checkout and sales). The funnel editor shows the bump picker on sales steps too.
  - The runtime sends the bump for the step, the funnel session context passes it to the page's form (`FunnelCodForm`), and the server accepts it from a published sales step.
  - The publish checks (bump usable, priced in the funnel's currency) cover it unchanged, since they already went over every step's `bumpOfferId`.
- **The product's own bumps** (Offers → Order bumps) show on the funnel's order form, on a sales page and on the checkout step alike, as on the store's product page.
  - They join the order as `orderBumps`, alongside the step's bump.
  - A refusal unticks them; the autosave and the purchase event count them.
- **Currency:** an add-on priced in another currency than the order's is not offered. The storefront filters them by currency, and the server refuses one with `ORDER_BUMP_UNAVAILABLE` (`offerRules.resolveBumpItems`), so a funnel selling in dollars never gets a line priced in pounds.
The courier's settlement statement is read from the file the courier sends (SPEC §15.5): an Excel workbook (.xlsx, its first sheet) or CSV. Before, the merchant had to re-save it as CSV.

- **Upload:** the dashboard sends the file as it came (`fileBase64` + `fileName`, at most 1 MB). The server reads it with the product import's dependency-free sheet reader (`catalog/importExport/sheetReader.js`). CSV text (`csv`) is still accepted; a request carries one or the other.
- **Header row:** couriers put a title, the account and the period above the table. The header is the first of the top 20 rows that names a waybill column and an amount column, and line numbers in the report are the file's own.
- **More header names** are recognised, e.g. "AWB No.", "Waybill No", "COD Value", "Delivery fees", "رقم التتبع", "قيمة التحصيل", "مصاريف الشحن". Punctuation and spacing in headers are ignored. Waybills are still compared exactly as before.
- **Skipped lines:** blank lines, and the totals line under the table (a "Total"/"الإجمالي" label), are not shipments. Any other line without a waybill is still reported as unreadable.
- **Errors:** a file that is not an .xlsx or CSV is refused with a clear message (422).
The builder's product list now honours its source (SPEC §8.2). Before, all three sources showed the same order.

- **newest:** display priority, then newest (as the shop's default).
- **featured:** the merchant's picks first — a display priority above 0, or the tag "featured" / "مميز" — then the rest newest first.
  - Featured products are not filtered out of the list, only ordered first, so a store that has picked none still shows its products rather than an empty block.
- **best_selling:** units sold in the last 90 days, cancelled orders left out, then display priority and newest.
- Both are sorts of the public listing (`storefront/productSearch.js`, `?sort=featured|best_selling`) and allowed as a shop's default sort.
- The storefront asks for them through `api-client/endpoints/productListSources.ts`.
- The single-product block without a product picked now takes the newest product, as its comment always said; it took the first by id before.
A failed online payment is now marked on the order and fires its event in every case (SPEC §11.4; new `payments/paymentFailure.js`).

- **The order's financial state becomes `failed`.** The value was in the enum but nothing ever set it. The orders list, its filter and the export already label it "Payment failed".
- **`order.payment_failed` fires once per failed attempt.** It is the trigger of the ready-made "payment failed + try again" automation.
  - Before, it fired only when the gateway declined.
  - It now also fires when the gateway refuses to start the payment at all (keys refused, no answer, a currency it does not take). That attempt was marked failed with no event, so the shopper got no reminder.
- **Back to `pending`:** starting another attempt (retry) or switching to cash on delivery. A capture makes it `paid` as before.
- **Left alone:** a cancelled order, or one with money already paid on it.
- The state change goes through `orderStateService.setFinancialState` (audited, stage tracked). The audit→event bridge maps no event to `failed`, so the event is recorded once, explicitly.
A rejected transfer now reaches the shopper, who can send a new receipt (SPEC §11.3; new `payments/transferResubmit.js`).

- **Telling the customer:** the merchant's "Reject" fires `order.transfer_rejected`.
  - It sends the new `transfer_rejected` order email (built-in Arabic text, with the order link) unless the merchant unticks "Tell the customer" in the reject dialog (`notifyCustomer`, on by default). The email is sent even when the store has not switched order emails on, like a refund's "notify the customer".
  - The same event drives a new ready-made WhatsApp automation, "Transfer rejected + send a new receipt", for stores that enable it.
- **The tracking page** (phone + number, or the signed link) shows the order's transfer:
  - under review; or
  - rejected, with the store's note and the method's instructions, and the checkout's own receipt form to send it again.
- **Sending it again:** `POST /store/:ws/orders/track-link/transfer`, authorised by the order's signed tracking token (the one the message's link and the tracking answer carry).
  - The receipt is checked like a checkout's: this visitor's upload, the method's required fields.
  - It becomes a new pending transfer of the same amount and purpose (a deposit stays a deposit), back in the merchant's review queue, audited as `manual_transfer.resubmit`. Rate limit: 6 per minute per IP.
  - A method the store has since removed can't be resent: the shopper is told to contact the store.
The deposit rule's "risky customers only" now reads the platform-wide delivery rate (SPEC §11.3 → §5.4).

- **Platform history first:** the customer's delivery rate across every store (`risk/networkStats.forPhone`: delivered out of the orders that finished) decides.
  - Below the rule's threshold, or reported as spam: the customer pays the deposit.
  - At or above it: they don't, whatever this store's own record says.
- **No platform history** (new to ZIMOS, or the network score not switched on for the store — the `customer_network_score` flag): the store's own record decides as before — a reliability score below the threshold, or a rejected order.
- **A first-time shopper nobody knows** is never asked.
- The threshold keeps its stored name (`maxReliabilityScore`, 1–100). The dashboard now calls it "Delivery rate below (%)" and explains both sources.
Lost orders now keep where the shopper came from (SPEC §6.1 attribution).

- **Sent with every autosave:** the storefront's first and last touch (`lib/touches.ts`: UTM values, ad id, click ids, referrer, landing page) go out with each save (`attribution`). They are stored on `checkout_sessions.attribution`.
- **A save with no touches keeps the stored pair.** Unknown keys are dropped rather than refusing the save. Nothing personal is accepted.
- **The lost order shows `trafficSource`:** the last touch, else the first.
  - Source: the UTM source, else the platform the click id points to, else the referring site.
  - Also medium, campaign, ad id and landing page.
- **The dashboard row reads "Came from facebook · autumn-sale".** Hovering shows the medium, ad and landing page. The CSV export gains "Traffic source" and "Campaign" columns, at the end so existing columns keep their places.
- **Converting a lost order copies its touches onto the order** when the order has none. The reports by source and campaign (`analytics/orderTouch.js`) then count it like any other order.
The merchant now sets when a checkout counts as lost (SPEC §6.2 `abandoned_after_minutes`), from the Lost orders page.

- **Where:** the line under the list ("A checkout counts as left after N minutes") gets a "Change" link. The link only shows for roles holding workspace.manage (owner, manager), because fraud_rules needs that permission. A 403 hides it.
- **The dialog:**
  - takes 5–1440 minutes, with 15 / 30 / 60 / 180 presets;
  - "Use the default" sends null, which puts back 15.
  - It is the Base UI Dialog that UI_SYSTEM.md asks for in new dialogs, so it has a focus trap and opens in a portal, centred wherever the page is scrolled.
- **Backend unchanged:** it already stores the value under `settings.fraud_rules.abandoned_after_minutes`. The lost-order list and stats read it, and the `checkout.detect_abandoned` job applies it per store, which starts the recovery automations.
- **After saving,** the list and the monthly figures reload, so rows that just crossed or uncrossed the line move.
"Notify the customer" on status changes, for one order or many (SPEC §4.6 `PATCH /:id/status {notifyCustomer?}` and bulk `set_status`).

- **Backend:**
  - PATCH /orders/:id/status and the bulk `set_status` payload accept `notifyCustomer`.
  - The move puts the choice on the event it fires:
    - order.confirmed, unreachable, postponed (confirmationService);
    - order.shipped, out_for_delivery, delivered, returned (shipmentLifecycle);
    - order.cancelled (cancelOrder, as the cancel button already did).
  - The customer-facing consumers already honour it:
    - **false:** no email, no push and no automation run;
    - **true:** the stage's order email goes out even while its template is off, as for cancellations and refunds;
    - **unset:** the store's settings decide.
  - Webhooks, pixels, affiliates and courier booking ignore it, since they don't speak to the customer.
- **Dashboard:**
  - The order page's "Change status" dialog shows the same "Notify the customer" toggle as cancel and refund (ticked by default). So does the orders bulk bar's "Change status".
  - The toggle only appears for moves the customer hears about: confirmed, follow-up, shipped, out for delivery, delivered, returned, cancelled.
  - It does not appear for reopening or sending an order back to the queue, which send the customer nothing. The list of those moves is `ORDER_STAGES_THAT_NOTIFY` in the api-client.
The order timeline now lists the messages the customer was sent about the order (SPEC §4.4 card 11 "message sent").

- **Migration 436:** `notification_logs.order_id` and `subject`, plus a partial index on order_id.
  - `notify.email/sms/whatsapp` take an optional `orderId`. When it is given, the log keeps it with the message's line: an email's subject, an SMS's text, a push's title.
  - Sign-in codes and staff notifications pass no order, so they keep neither field and no code is ever stored.
- **What passes the order:**
  - the order emails (orderEmailService.handleEvent);
  - an automation's SMS and email steps;
  - the shopper's order push (the sandbox provider logs it).
  - WhatsApp messages from the store's number already carried `order_id`.
- **`GET /orders/:id/timeline` adds `message` events:** `{ channel, template, subject, status, error, bot? }`.
  - From notification_logs, and from the store's outbound whatsapp_messages, with who sent them and whether WhatsApp reported them delivered or read.
  - The automation run line stays as it was. The message line under it shows what was actually sent.
- **The order page's timeline shows:**
  - "Email / SMS / WhatsApp / Notification to the customer — sent / delivered / read / not sent";
  - the message's line, and the provider's error when it failed.
- **Next free migration: 437.**
The orders list and the order page show product pictures, the funnel's name as the source, and "New customer" (SPEC §4.3 columns, §4.4 card 1).

- **Backend:** new `orders/orderListDecor.js`, called from `hydrateOrders` (the list) and `getOrder` (the page). It runs one query per kind for the whole page.
  - `items[].imageUrl`: the variant's image, else the product's first media. It is read live, so a changed photo shows on old orders, and it is null when there is none.
  - `funnelName` for a funnel order.
  - `isNewCustomer` (list only): no earlier non-test order from the same customer in this store. The order page already had "New customer / Returning" from the session details.
- **Dashboard list:**
  - A "Products" column with the first three lines' pictures (a package box when there is none), "+N" for more, and name × quantity on hover. It is on by default, for teammates who never picked their columns.
  - A "New customer" badge under the customer.
  - The funnel's name under "Funnel" in the Source column.
- **Order page:**
  - Each line in the items card has its picture.
  - The source badge reads "Funnel: <name>".
  - The picture component (`OrderLineThumb`) is shared by the list and the page.
Dropshipping: send an order to the supplier from the order page, forward automatically, and follow its status (SPEC §16.5). It is built on the `DropshipProvider` contract and its sandbox. Real suppliers stay out of scope (§16 boundary).

- **The order page's Supplier card** (new `dropship/dropshipOrders.js`, mounted in the orders router):
  - Shown only when a supplier is connected (its app installed) or the order was already forwarded.
  - Lists what was forwarded: the supplier's order number, its status in the supplier's own words (translated when it is one of the usual ones), what that status means here, and when it was last checked.
  - "Send to <supplier>" and "Ask the supplier now" need orders.manage. Viewing needs orders.view.
- **Mixed orders:** each supplier gets only the lines whose product was imported from it (`linesFor`, used by `pushOrder` everywhere).
- **Automatic forwarding**, set per supplier on the suppliers page (stored in the connection's config, `PATCH /dropship/providers/:code/settings`):
  - Off, as soon as the order is placed, or once it is confirmed.
  - The `dropship_forward` consumer on order.created / order.confirmed forwards orders holding that supplier's products.
  - Test orders and unpaid online orders are never forwarded.
  - A refusal is logged on the order (`dropship.forward_failed`) so the merchant can send it by hand.
- **Following:**
  - The contract gains an optional `getOrderStatus(credentials, externalOrderId, ref)`. The `dropship.follow_orders` job (every 5 minutes) asks about forwarded orders not checked in the last 10 minutes, for up to 60 days, until delivered, returned or cancelled.
  - A new status is recorded and appears on the timeline as "The supplier updated the order".
  - With "Move the order when the supplier's status changes" on, the mapped stage is applied through the normal status change (owner as actor, reason "<supplier>: <status>"), and only when the order can make that move by hand.
  - The sandbox moves with time: confirmed at 1 minute, shipped at 3, delivered at 6. A number ending in 0 comes back cancelled.
- **Migration 437:** `dropship_order_refs.checked_at`, `last_error`, `forwarded_by`. **Next free migration: 438.**
The `order.status_changed` webhook carries `old_status` and `new_status` (SPEC §16.1, "like EO").

- **What they are:** the order's stage before and after, the status the orders screen shows. They sit in `data` next to `previous` / `current` / `changed`, which stay as they were.
- **When they are equal:** when only a state behind the stage moved (a payment), with `changed` saying what did.
- **An order placed before the endpoint existed** gets `old_status: null`, as `previous` is null.
- **Docs:** the event's description in the catalogue (`GET /webhooks` → events, shown in the dashboard) and `docs/public-api.md` (sample payload and an explanation) say so.
- **Backend only:** the dashboard reads the event catalogue from the server.
Contact tags from purchase buttons and order forms on website pages too (SPEC §18.4), not only in funnels.

- **The shopper's side.** On a published store page, a `button` or `cod_form` that has "Tags added to the customer" is wrapped in `PageTagScope`.
  - Pressing the button, or starting to fill in the form, remembers `{ pageId, elementId }` on the device (`lib/pageTags.ts`, for 24 hours, at most 10).
  - The next order sends them as `pageTags`, from any checkout (`placeCodOrder`), and the list is cleared once the order is placed.
  - Funnel steps and the editor preview are not wrapped: funnels tag through their own outcomes.
- **The server's side.** The checkout accepts `pageTags` (at most 10).
  - After the order is created, `contacts/pageTags.js` finds each element in the store's **published** website snapshot, takes its `contactTags` (only for button / cod_form) and adds them to the order's customer, cleaned as contact tags.
  - The browser sends only where the element is, never the tags. A page or element that no longer exists, or one that does not tag, adds nothing.
  - It never fails the order.
- **Builder:** the hints for button and order-form tags now say they work on store pages and in funnels.
- **Tested** on the scratch DB with tags temporarily added to the published `/cap-landing` order form:
  - Ordering through the page gave the customer `cap-lover` and `summer 2026`.
  - Forged references (a heading, an unknown page) added nothing.
  - The snapshot was restored exactly.
Subscribers now get their portal link (SPEC §18.1: "cancel or update the card via a signed link sent to them by email/WhatsApp"). Before, it only reached them when a renewal failed.

- **Email.** A new order email "Subscription started" (`subscription_started`, on `subscription.created`) carries `{{subscription_link}}`: the portal at `/subscriptions/<portal token>`, where the subscriber changes the card or cancels.
  - **Decision: it is on by default** (`defaultOn`), unlike the other order emails, because it is the customer's only way into their subscription.
  - A template never touched counts as on. Editing its text keeps it on. The merchant can turn it off under Order emails.
- **Subject and variables.** A subscription event's email speaks about the subscription (product, amount, page) through the automation's subscription subject. The new token `subscription_link` exists for automations too, and `payment_link` stays the portal on subscription triggers as before.
- **WhatsApp.** `subscription.created` is now an automation trigger, with a ready WhatsApp template "Subscription started + its link".
  - It is WhatsApp only: the email already goes out from Order emails.
  - The automation engine now treats an event that names a subscription as about the subscription, even when it also names the order.
- **Tracking page.** The order's tracking page lists the subscriptions that order started, with their status and a "Manage" link (`subscriptions` on the tracking answer, `subscriptions/subscriptionLinks.js`).
- **Dashboard.** The merchant's "Copy portal link" on the subscriptions screen was already there.
The store's subdomain can be changed from Settings (SPEC §17.3 account settings: "the subdomain").

- **Dashboard.** A new "Store address" section above Account settings:
  - Shows the current `<slug>.zimos.co`. "Change address" opens the existing address field, now translated and read left to right, with the live check. The check passes this store's id, so its own current and previous addresses read as available.
  - Moving asks for confirmation in a Base UI Dialog, saying the old links keep working.
  - The section lists the previous addresses that still forward here.
  - The change needs workspace.manage (owner, manager). A 403 hides the button.
- **Decision: old addresses are kept** (new `workspace_slug_history`, migration 438; `workspaces/slugHistory.js`), so a change does not break links already handed out:
  - The old address stays the store's. check-slug answers "taken" for anyone else, the PATCH refuses it, and a new store's automatic slug skips it.
  - The same store can take one back, which removes it from the list.
  - The last 3 are kept per store; an older one is released.
  - `resolve-host` answers an old platform host with `redirectTo` the store's primary domain, else its current subdomain. The storefront proxy redirects (307, same path and query) for page loads.
  - Everything else still reaches the store by the old slug: the public `/store/:slug` lookup and the API's host resolver fall back to the history.
- **Tested** on the scratch DB:
  - Moved the demo store to demo-store-two by API and back again through the dashboard in Arabic.
  - The old host resolved with redirectTo, the storefront answered 307 to the new host, and the public lookup by the old slug worked.
  - Restored to demo-store with no history.
- **Next free migration: 439.**
New-order notifications now name the product and the governorate, and reach each teammate in their own language (SPEC §20.1: "its content (product + total + governorate)").

- **Content.** The line is "<first product> × qty (+N more) · <total> · <governorate>".
  - The governorate uses its Arabic or English name when the address names a known place (geo/geoRegions.resolve), else the text as typed.
  - The customer's name is no longer in the push or email line; it is still in the notification's data.
  - The values are also in `data` (`product`, `moreProducts`, `governorate: { ar, en }`), so the dashboard bell renders the line in the viewer's language. Older notifications still show "customer — total".
- **The teammate's language.** New `users.locale` (`ar`/`en`, migration 439), which the dashboard sends through `PATCH /auth/me/profile { locale }`:
  - once when it differs from the server's value, and again whenever the teammate switches language;
  - this does not write an audit line.
- **Delivery.** `merchantNotificationService.create` takes an optional `localized: { ar, en }`. Each teammate's bell row, push, email and WhatsApp use their language. Teammates whose language is unknown get Arabic, as before.
- **Tested** on the scratch DB:
  - Opening the dashboard in English stored `en` for the owner.
  - A two-product order in Cairo notified "New order … · Demo T-Shirt × 2 +1 more · 706.80 EGP · Cairo".
  - With Arabic it read "… و1 غيره · … · القاهرة", and the bell shows the same.
- **Next free migration: 440.**
The AI's store policies are now applied to the store's own policies (SPEC §19.2 "Store policies", into §8.3), instead of being copied by hand.

- **Decision: a fourth long policy, `shipping_policy`.** §8.3 notes that shipping, returns and privacy policies are required for TikTok ads, and the AI writes those three, but the store only had refund, privacy and terms.
  - It now sits in `settings.legal` next to them and works like them: the footer link, `/policies/shipping-policy`, the sitemap, the page builder's `legal.shipping_policy` binding, and the funnel checklist.
  - The dashboard's Policies tab has it with Arabic and English templates, and the storefront names it in ar, en and fr.
- **`POST /ai/jobs/:jobId/apply-policies { policies? }`** (website.edit, `ai/applyPolicies.js`):
  - Writes a `policies` result, or a store builder's: shipping → shipping_policy, returns → refund_policy, privacy → privacy_policy. Only the parts asked for (all three by default); terms of service are never touched.
  - Returns `{ written, replaced }`, and is audited (`ai.apply_policies`).
  - Can be done again; the job is not marked applied.
- **AI Studio.** The Policies tool and the store builder's result have a "Use as my store policies" button. When the store already has some of them, it names them and asks once before replacing. Afterwards it links to the store policies.
- **Tested** on the scratch DB:
  - A generation applied over an existing refund policy reported `replaced: ["refund_policy"]` and kept the terms.
  - The storefront served the shipping policy page with its footer link.
  - The dashboard flow worked in Arabic.
  - The test policies were removed afterwards.
The builder picks products and collections from the store's own catalogue (SPEC §9.3), instead of asking for a pasted ID. Each pick has an "Edit product" link.

- **A product picker** (`editor/ProductPickerField.tsx`):
  - A search box runs the catalogue's own search (name or SKU) over active and draft products.
  - The list below it shows the matches; a draft product is marked as one.
  - "Edit product" opens the picked product in a new tab.
- **Where it is used.** Every block's "product" field is now this picker:
  - product cards, the product page blocks, the 3D product, the button's product, and the showcase items, including their second product;
  - the orbit gallery's collection gets the same picker for collections, with a link to the collections page.
- **Decision: it still stores the product's ID, and old values keep working.**
  - A value typed by hand before (an ID, or a slug in the showcase items, which the storefront also accepts) stays as it is.
  - If the product is found, the picker shows it by name. Otherwise it shows "Saved value: …".
  - Nothing is rewritten until the merchant picks something.
  - The variant ID stays a text field.
- **Tested** on the scratch DB, in Arabic, on the Cap landing page's product price block:
  - Searching "cap" left only Demo Cap.
  - Picking it set the block's product.
  - "Edit product" pointed to `/catalog/<id>`.
  - The page was not saved.
The funnel's page editor gets three of the §9.3 top-bar and element-menu tools it was missing: a tablet preview, previous/next page, and "select parent".

- **Tablet preview.** The website editor already had a tablet width in its device switch; the funnel page's preview now has it too (desktop, tablet, mobile).
- **Previous / next page.** Arrows on either side of the step picker move to the funnel's previous or next page.
  - **Decision: the order is the funnel's own step order**, the same as the step picker's list. It is not a walk of the flow's links, which can branch (accept or decline).
  - At the first or last page the arrow is disabled and says so.
  - The step picker now keeps a usable width; the page's actions move to their own line when the space runs out.
- **Select parent** (the inspector, so the website editor gets it as well):
  - Each element's caption row and each column's header have a "Select its parent: …" button.
  - An element's parent is its column when the section shows its columns, otherwise the section. A column's parent is the section.
  - **Decision: "selecting" the parent brings its controls into view in the inspector, focuses them and outlines them briefly.** The canvas picks whole sections and the inspector already lists the section's whole tree, so there is no separate element selection to move.
- **Tested** on the scratch DB, in Arabic and in English, on the "Link test" funnel:
  - The arrows went sales → checkout → thank-you and back, disabled at both ends.
  - On a three-column section, an element's button outlined and focused its column, and the column's button went to the section's settings.
  - The tablet button narrowed the preview.
  - Nothing was saved to the funnel.
Funnel split tests can now have more than two versions (SPEC §9.6: "2 or more variations, each with a distribution percentage totaling 100%"). The backend already took up to five, keyed A–E; the dashboard only made A and B.

- **Starting a test.** The form lists the versions and each one's share of visitors (`funnels/SplitTestVersions.tsx`):
  - "Add a version" goes up to five and re-splits the shares evenly. There is also a "Split evenly" button, and each version except A can have a name.
  - The test only starts when the shares add up to 100.
  - Every version but A starts as a copy of the page.
- **A running test.**
  - Each version's row has its own "Edit {key}'s page". Saving it sends every version's page back, since the API checks all of them.
  - "Versions and shares" adds a version or moves the shares; visitors already in a version stay in it.
  - **Decision: a version visitors have seen cannot be removed from a running test.** Their pinning and its numbers would be lost. Its share can go to 0 instead, which stops sending new visitors to it.
- **Confidence with more versions.** With more than two versions, the line names who it compares: "{pct}% sure C really converts better than A" (the leader against the runner-up, as the server computes it).
- **Fix found on the way:** the "Tests and settings" window was the old Modal, mounted inside the funnel editor's top bar, which clipped it to the bar's height. It is now a portalled Base UI dialog.
- **Product A/B tests** (`ProductTestSection`) stay at two versions: a price test's versions each carry prices, which is a separate change.
- **Tested** on the scratch DB:
  - In Arabic and in English, on two published funnels: created a three-version test with a named C, added a fourth version to the running test (25% each, only D removable), and saved C's page.
  - On the funnel itself, 50 new visitors were spread over A 14, B 10, C 19 and D 7.
  - The tests, their assignments and the test sessions were deleted afterwards.
Each coupon in the dashboard's discounts list has a "Share link" (SPEC §10.5: "a share link that applies the coupon automatically: ?coupon=CODE"). The storefront already remembered a `?coupon=` link on any page of the store or a funnel and applied it at checkout; there was no way to get the link.

- **The dialog** (`discounts/CouponLinkDialog.tsx`, a Base UI dialog):
  - Pick where the link opens, see the link, and copy it.
  - **Decision: the choices follow the coupon's own limits.** Places where the coupon would not apply are not offered:
    - A coupon limited to some funnels opens one of those funnels.
    - A coupon limited to some products opens one of those products.
    - Any other coupon can open the store's home page, an active product, or a published funnel.
- **Links** are built on the store's address, like the dashboard's other store links (`storeUrl(slug)`):
  - a product: `/products/<slug>?coupon=CODE`;
  - a funnel: `/f/<subdomain>?coupon=CODE`, or `VITE_FUNNEL_PUBLIC_BASE_URL` when it is set.
- **Warnings in the dialog:**
  - when the coupon isn't running now (disabled, scheduled or expired);
  - when the store's own coupons switch (`allow_discount_codes`) is off.
  - Archived coupons and automatic discounts (no code) have no link.
- **Tested** on the scratch DB, in Arabic and in English:
  - An open coupon offered home, products and funnels.
  - A product-limited coupon offered only Demo Cap, and a funnel-limited one only its funnel. The copied links matched.
  - A disabled coupon showed the warning.
  - On the storefront, the product link remembered the code and showed "كوبون SHARECAP" on the order form. The funnel link remembered its code and opened the funnel. Both paths also answer 200 through the store's own host.
  - The test coupons and the session were removed.
A funnel page's settings have a Details tab (SPEC §9.3: "Details tab (the link using letters, digits and hyphens, internal title, type…)"). It shows the page's title and address, and a generic page's address can now change.

- **The tab** (dashboard `funnels/StepDetailsForm.tsx`, shown first in the page settings dialog when a page passes one):
  - The page's title. On a generic page this is also its link text in the funnel's footer.
  - Its address: what is typed becomes lowercase letters, digits and hyphens, with the public path shown under it.
  - Its type.
  - "Apply" puts the change into the funnel draft; it is saved with the funnel's Save, like every other edit.
- **Decision: only a generic page's address can change.** A step's key is its address, and steps on the map are referred to by key (edges, visitors' sessions). Generic pages have no edges.
  - The backend now accepts `key` on a step update for a `custom` step that no edge touches and that has no split test (a finished test still serves its winner by key). Anything else answers 409 `FUNNEL_STEP_KEY_LOCKED`. A clash answers the existing `FUNNEL_STEP_KEY_TAKEN`. The logic is in `funnels/genericPageAddress.js`.
  - On a page on the map, the address field is read-only and the tab says why.
- **Decision: old addresses keep working.**
  - The keys a page had are kept in `seo.previousKeys` (the five latest). An seo update that doesn't mention them keeps them.
  - The public page lookup falls back to them.
  - The storefront answers an old address with a permanent redirect (308) to the new one.
- **Tested** on the scratch DB:
  - Through the API: renamed a new generic page `about` → `our-story` (`previousKeys: ["about"]`). Renaming a map step answered 409 LOCKED, a clash 409 TAKEN, and "Bad Key" 422.
  - After publishing, `/p/about` and `/p/our-story` both served the page, and the storefront redirected `/p/about` to `/p/our-story`.
  - In the dashboard, Arabic and English:
    - A map step's address was read-only.
    - Typing another page's address said it was taken, and "Our Story 2024!" became `our-story-2024`.
    - Apply and Save stored the new key and title.
    - Going back to `our-story` left `previousKeys: ["our-story-2024", "about"]`.
  - The test page was deleted and the funnel republished.
The rest of the store's own words can now be translated (SPEC §8.10). Product names and descriptions, collections, pages and funnels were already translated.

- **Two new kinds, text by text, like pages** (`translations/moreTexts.js`). Each text is stored once under a hash of the original, so an edited text shows as untranslated again.
  - **Product details** (`product_details`, one entity per active product): the special-offer line, option names and values, offer names and badges, and the product page content (feature titles and descriptions, what customers said, questions and answers).
  - **Store texts** (`store_text`): four sections per store, each with an id made from the store's id:
    - menus: header links, footer columns and their links, footer text, and the announcement bar;
    - the legal policies;
    - store info: the tagline and the trust cards;
    - the thank-you page text and the checkout's thank-you line.
- **They use the existing machinery:**
  - The `/translations/content` list and save.
  - The Languages percentages, which now count these texts too.
  - "Translate what's missing with AI", which takes both kinds.
  - The dashboard's Languages screen has two more tabs, "Product details" and "Store texts", with the sections named in the merchant's language.
- **In the shopper's language** (X-Store-Locale, when the store offers it):
  - The public product answers carry the translated texts.
  - The store answer carries the translated menus, announcement, footer, tagline, trust cards and thank-you texts.
  - A policy is translated first and has its `{{store.name}}`-style variables filled in after.
  - A missing translation shows the original, and nothing throws.
- **Decision: option values are never replaced.** The storefront finds the variant by them and swatches are keyed by them. The product carries `optionLabels` instead, and the option picker shows those labels for the option's name and values while still selecting by the stored value.
- **Decision: custom field labels are left out.** They are already written in Arabic and English on the product itself.
- **Tested** on the scratch DB with temporary texts (a header link, announcement, footer column, refund policy, thank-you line, and a product with an option, a special-offer line, a question and an offer):
  - Both kinds listed every text. English translations saved (7/7 and 6/6), and the overview went to 31%.
  - In English, the API and the store page showed "Size (EN): Medium", "Limited-time offer", the translated question, and "Deals / Free shipping over 500 EGP / Help / Track your order".
  - The refund policy page read "…within 14 days from Demo Store.", and the offer came back as "Buy 2 and save / Best seller".
  - In Arabic, everything stayed the original. The variant still matched by "M".
  - The store, the product, the offer and the translations were restored afterwards.
Product descriptions can be formatted (SPEC §7.1 "description (rich text)"): headings, bulleted and numbered lists, bold, italic and links. They are safe however they arrive.

- **Decision: a description is stored as text with a few marks, never as HTML:** `## heading`, `- item`, `1. item`, `**bold**`, `_italic_`, `[text](https://…)`.
  - The store and the dashboard parse the marks (api-client `endpoints/richText.ts`) and draw them with their own elements. React escapes every character, so nothing in a description can run in a shopper's browser, whatever was typed.
  - Links are kept only for http(s), mailto and tel; externals open with `rel="nofollow noopener noreferrer"`.
  - Existing plain descriptions render as before: paragraphs and line breaks.
- **Sanitizing** (`catalog/richDescription.js`, on product create and update, and on the Shopify import that used to strip all formatting):
  - HTML is turned into the marks: paragraphs, line breaks, headings, lists, bold, italic and safe links.
  - Everything else is dropped, keeping only the words: script, style, iframe, svg and their content, event handlers, attributes, `javascript:` links, other tags. Entities are decoded.
  - Text that isn't HTML is kept as written (only control characters and long runs of blank lines are tidied).
- **Plain text where formatting doesn't belong:** the product feeds, the store's meta description and shared product data (JSON-LD), product cards, and a page's bound `product.description` use the text without its marks.
- **Dashboard:** the product form's description has a toolbar that writes the marks around the selection (bold, italic, heading, bulleted and numbered list, link with its address selected for typing), a Preview, and a hint. It is in both languages.
- **Decision: an italic mark may follow an Arabic letter** ("و_خفيف_"), but not a Latin letter or digit, so snake_case words stay as they are.
- **Tested** on the scratch DB:
  - Saving HTML with a heading, bold, italic, a list, a safe link, a `javascript:` link, a `<script>` and an `<img onerror>` stored only the marks and the words.
  - The store page drew h3, strong, em, the list and the safe link (with nofollow). No script or img was inside, and no alert fired.
  - In the dashboard (Arabic), Bold wrapped the selection, Numbered list numbered two lines, and Preview showed the numbered list.
  - The cap's description was put back afterwards.
  - Dashboard, storefront and platform-admin typecheck.
Physical products have a "Track quantity" switch, and variant prices are labelled in the store's own currency (SPEC §7.1 "Inventory: quantity, tracking, disable when out of stock — present them more simply").

- **`products.track_inventory`** (migration 440, default on: every product so far was tracked), `trackInventory` on the product API.
- **Decision: an untracked product keeps every variant at `allowOverselling = true`** (`catalog/stockTracking.js`).
  - Everything that decides whether a variant can be sold already asks `allowOverselling || available > 0`: the store, checkout, reservations, order bumps, feeds and the WhatsApp bot. So none of them had to change, and stock movements are still recorded.
  - Turning tracking off sets every variant to allow overselling. Turning it back on starts them all at "stop at zero"; overselling can then be allowed per variant again.
  - A variant added to, or edited on, an untracked product keeps allowing overselling.
- **Low-stock alerts:**
  - An untracked product raises no `product.low_stock` event (the variant hook checks the product).
  - The stores overview's low-stock count leaves untracked products out.
- **Dashboard:**
  - The product form shows the switch for physical products, with a line saying what it does.
  - When it is off, creating the product asks for no initial stock and no overselling choice.
  - The variants table shows "Not tracked" instead of stock, and the variant form hides stock and overselling.
  - The products list says "Not tracked" for such a product, as it does for digital products and services.
- **Currency:** the price, compare-at and extra-fee inputs of a new product, and a new variant's price, cost and compare-at, now show the store's currency (`defaultCurrency`, which the backend prices new variants in) instead of a fixed "EGP". An existing variant still shows its own currency.
- **Tested** on the scratch DB:
  - Through the API on Demo Cap: untracked set its variant to overselling. Trying to switch overselling off on a variant stayed on. A stock drop across a low-stock threshold raised no event while untracked, the store showed it in stock, and the same drop raised one event once it was tracked again.
  - In the dashboard (Arabic): turning the switch off and saving showed "غير متتبع" in the variants table and the products list. The new-variant form had no stock or overselling field. With the store's currency set to SAR for the test, the form showed SAR. Turning it back on brought the stock numbers back.
  - Thresholds, stock movements, the event, the currency and the switch were restored.
Analytics have a currency switcher (SPEC §11.5: "Analytics include a currency switcher (EGP / USD / MAD...)") on the summary, the reports, attribution, profit, real profit and funnel analytics pages.

- **Decision: display only.** Reports keep adding orders up in the store's own currency (currencies/baseAmounts.js, unchanged).
  - The switcher shows those amounts in another currency at the store's current rates. Nothing is stored converted.
  - When a currency is picked, a line under the switcher says the amounts are converted and that orders are added up in the store's currency.
- **Rates:** GET /currencies (readable by any member) now also returns `reportRates`, from the store's currency to its display currencies plus a few common ones (USD, EUR, SAR, AED, MAD, EGP), whichever have a rate. The switcher hides itself when there are none.
- **Conversion** (`lib/reportCurrency.tsx`):
  - Each page wraps its amounts with `useReportMoney()`, which turns an amount in the store's currency into the chosen one.
  - It allows for the two currencies' decimals and rounds half away from zero to the minor unit.
  - An amount in any other currency is left as it is.
  - Chart tooltips and axes go through the same function.
- **Decision: the choice is the teammate's, per store, in this browser** (localStorage), and all report pages share it. Choosing the store's own currency again goes back to the plain amounts.
- The live view (today's orders as they come in) and the product costs page stay in their own currencies.
- **Tested** on the scratch DB, in Arabic: the switcher offered EGP (store), AED, EUR, MAD, SAR and USD. On the summary, 118,544.16 EGP of sales became 2,469.67 US$ (rate 0.02083333) and the note showed. The reports, attribution and profit pages opened already in USD. Switching back showed EGP again.
Orders can be exported in a courier's own layout (SPEC §12.3: "A carrier without an API remains manual: the merchant exports an Excel file in the format the carrier requires").

- **Courier layouts** (`orders/exportPresets.js`, kept in `settings.order_export_presets`, up to 20 per store):
  - A layout is a name, rows per order or per product, CSV or Excel, and the courier's column titles in its order.
  - Each column is filled from one of the export's columns or with a fixed value the courier asks for ("Service type: Delivery").
  - Endpoints: `GET /orders/export/presets` (orders.view); `PUT /orders/export/presets` to create or replace, and `DELETE /orders/export/presets/:id` (both orders.manage, audited).
  - A column must name a known export column or a fixed value, not both.
- **Exporting with one:** `preset=<id>` on GET /orders/export and POST /exports/orders writes the file with the layout's titles, order and rows. Phone masking, dates in the store's timezone and the spreadsheet formula guard are as before.
  - **Decision:** a background export copies the layout when it is asked for, so editing the layout later doesn't change a file already being built.
- **Two new export columns** couriers ask for:
  - "Amount to collect": the unpaid part of a cash-on-delivery order, 0 otherwise; a number in Excel.
  - "Full address": street, city and governorate in one cell.
- **Decision: no courier's layout is shipped ready-made.** We don't have their official sheets, and guessing them would put wrong columns on real waybills. The merchant builds each one from the courier's sample file:
  - The export dialog takes the courier's header row pasted from Excel (tabs, or a CSV line) and turns every title into a column.
  - It guesses each field from the title (name, phone, second phone, governorate, city, address, amount to collect, quantity, description, notes, reference) for the merchant to check.
- **Dashboard:** the export dialog has a "Layout" choice ("Your columns", or a saved courier layout) with New / Edit. The editor has the name, the paste box, the columns (title, field or fixed value, move, remove), rows and file. With a layout chosen, the dialog shows its columns instead of the column checkboxes.
- **Tested** on the scratch DB:
  - Through the API: an 8-column Arabic layout saved; an unknown field and a field-plus-fixed column answered 422. CSV and Excel exports with the layout came out with the courier's titles, the full address, amount to collect (250.00, 570.00) and the fixed "توصيل".
  - In the dashboard (Arabic): pasting a header row of 8 titles guessed all eight fields right (the service type as a fixed value). The saved layout was selected, and "Prepare file" built the Excel in the background with the layout copied into the job.
  - The layouts, the file and its notification were removed afterwards.
Stores can add the Pinterest Tag (SPEC §13.1: "Pinterest — Tag | Conversions API — P2").

- **Backend:** `pinterest` is a tracking-pixel platform (`marketing/trackingPixelService.js`). Its id is the tag's digits (10–16). Like every pixel, it can cover the whole store or some funnels or products.
- **Decision: the browser tag only.** Pinterest's Conversions API is sent per ad account (an ad account id and its token, not the tag id), and the SPEC marks it P2. So `capi` is off for Pinterest and the dashboard shows no server-events switch for it.
- **Storefront:**
  - The tag script (`s.pinimg.com/ct/core.js`) loads with the store-wide tags and a `pintrk("page")`.
  - Events map to Pinterest's standard ones: page view → `page`, product view → `pagevisit`, add to cart → `addtocart`, purchase → `checkout` (only when the store reports Purchase at order time, like the others), lead → `lead`. Checkout started and payment info have no Pinterest event.
  - Each event carries value, currency, quantity, the order id, `line_items`, and the same `event_id` the other platforms use, for dedup.
  - Like Snap, a Pinterest event reaches every loaded tag, so a funnel's or product's tag is loaded when the shopper first reaches it.
- **Dashboard:** Pinterest is in the platform list with its ID shape and an example.
- **Tested** on the scratch DB:
  - Adding a tag through the API worked, and a bad id was refused. The store's public answer listed it.
  - On the product page the tag script was requested and queued `load 2612345678901` and `page`.
  - Add to cart queued `track addtocart {value 250, currency EGP, order_quantity 1, event_id, line_items}`.
  - The tag was deleted afterwards.
Stores can write orders, lost orders and leads into their own Google sheets as things happen (SPEC §16.4).

- **Scope decision:** SPEC §16 leaves the real Google connection to the integrations team (§22 table: "Google Sheets … builds on …"). So, per LANES rule 6, this item is the interface + a `sandbox` adapter + a README:
  - `modules/sheets/adapters`: `GOOGLE_SHEETS_PROVIDER`, default `sandbox`. The sandbox is refused in production, where the page says Google Sheets is not available yet.
  - The sandbox keeps each spreadsheet as a JSON file. A sheet id ending `-revoked` or `-flaky` acts out a revoked token or an outage.
  - The README lists what the `google` adapter must do: `drive.file` scope, offline refresh token, `valueInputOption=RAW` so a name never runs as a formula, and the row number read from `updatedRange`.
- **Backend:**
  - Migration 441 adds `sheet_connections` and `sheet_row_refs`. The account's tokens are sealed in `workspace_integrations` (`google_sheets`) and never sent to the browser.
  - Routes live at `/integrations/google-sheets` (apps.manage). Changes need the Google Sheets app installed: it moved from "coming soon" to available, opening `/apps/google-sheets`. Uninstalling it stops the writing.
  - **What gets written:**
    - A new order adds a row. Any later order event (confirmed, shipped, delivered, cancelled, paid, edited, shipment status…) rewrites the same row with the order as it is now; the row number is kept in `sheet_row_refs`.
    - Lost orders (abandoned, refused, payment failed) add a row; recovering one rewrites it.
    - Leads are the contact-form and funnel opt-in sign-ups (`contact_form.submitted`). They are written once.
  - **Columns:**
    - Orders use the export's columns (the same list as the courier layouts), the checkout form's custom fields (`field:custom_N`), or a fixed value.
    - Lost orders and leads have their own column lists.
    - "Group products into one row by order number" chooses one row per order or one per product line.
  - **Filters:** orders by products and funnels, lost orders by products, leads by funnel.
  - **Language and phones:** the sheet's language sets the dates and status words. Phones are masked when the teammate who added the sheet can't see them.
  - **Failures:**
    - A failure that may pass is retried by the outbox.
    - Revoked access or a deleted sheet stops that sheet (`revoked` / `error`) and alerts the store once a day at most, in each teammate's language.
    - Connecting the account again resumes revoked sheets.
  - **Sync existing** adds the last 30 days that aren't in the sheet yet, in batches, up to 2000.
- **Dashboard (`/apps/google-sheets`):**
  - The page has the account panel (connect, which comes back with `?code&state`; disconnect; "connect again" when access was removed) and the list of sheets.
  - Each sheet shows its status, rows written and last write. Actions: Sync existing, pause/resume, edit, delete, and Preview (sandbox).
  - The add/edit dialog sets the name, what the sheet carries, the language, the columns (ordered, field or fixed value, defaults), the grouping switch and the product/funnel filters.
- **Tested** on the scratch DB, in Arabic and English, through the page:
  - Install, then connect (sandbox round trip).
  - An orders sheet got its 19 default columns plus a fixed column. A new order appeared in it.
  - A status change rewrote the same row. Sync existing added 451 orders with no duplicates. Pause/resume worked.
  - A leads sheet got a live sign-up plus 5 older ones. A lost-orders sheet got 9 rows.
  - Revoked access stopped the sheet with a badge, a banner and a notification in the viewer's language. Connecting again resumed it.
  - All test data was removed afterwards: orders, customers, sign-ups, sheets, the app install and the sandbox files.
The dashboard home opens with the period the merchant last chose, and contacts can be tagged in bulk from the list (SPEC §15.1, §18.4).

- **Home (frontend only):**
  - The period, the store/funnel filter and the currency of the overview, and the 7/30-day switch of the site traffic, are kept per store in this browser (`lib/rememberedChoice.ts`, `zimos.home.*.<store>`).
  - **Decision: per browser, not per account.** It is a viewing convenience, like the list sort. The default stays 7 days (SPEC §15.1), and choosing the default clears the stored value.
  - A stored value that is no longer valid falls back to the default: an unknown period, a deleted funnel, or a currency the store no longer offers.
- **Contacts (frontend only):**
  - The list has a tick box per row and one for all the rows shown.
  - While some are ticked, a bar offers "Add tags" and "Remove tags". The dialog takes typed tags (comma or Arabic comma) or picks from the tags in use.
  - It calls the existing `POST /contacts/bulk-tag`, in batches of 200, the server's limit. The selection clears after the change and when the filters change.
  - **Decision: tick boxes cover the loaded rows.** There is no "every contact matching the filter" option: a segment already covers "everyone who…", and the server takes explicit ids.
- **Tested** on the scratch DB, in Arabic and English:
  - The period, funnel and site range stayed after a reload and after moving to Orders and back.
  - A stale funnel and a bad period fell back to the store and 7 days, with no error.
  - On 3 ticked contacts, an empty submit was refused, then "pw156-vip, wave 2" plus the picked "newsletter" were added to exactly those 3.
  - "Select all" ticked 50, and removing the two tags left "newsletter" in place.
  - Contact tags were restored from a snapshot afterwards.
  - The test server ran with a higher request limit. The home page makes enough calls that reloading it in a loop hits the normal 100 per minute; the normal limit is back.
Every builder element now has the full Style tab (SPEC §9.3, Lightfunnels' element styles).

- **New options:**
  - **Background:** a gradient (start and end colour, angle) laid over a background image (fit: fill, whole or original size; position).
  - **Sizes:** height, minimum and maximum height, minimum width.
  - **Custom shadow:** inner or outer, with colour, across, down, blur and spread. It replaces the small/medium/large preset.
  - **Other:** overflow (show, cut off, scroll) and the pointer shape.
  - **Visibility:** "hide when the phone is upright / sideways", beside the existing per-device hide.
- **Where it lives:**
  - Backend rules: `pages/styleExtras.js`, merged into `elementStyle.js`.
  - Storefront CSS: `page-renderer/elementStyleExtras.ts`.
  - Dashboard fields: `editor/StyleExtrasFields.tsx`, inside the Style and Layout tabs.
  - Each value is stored per device like the rest, so a tablet or mobile override works the same way.
- **Decision: the image address is the one free-form style value.**
  - Both sides hold it to http(s) or a site path, using characters that cannot leave `url("…")`: no quotes, brackets, spaces, backslashes or semicolons.
  - Every other value is a clamped number, a keyword or a hex colour, as before.
- **Decision: upright vs sideways.**
  - Upright means a narrow portrait screen (≤ 639 px wide).
  - Sideways means a short landscape screen (≤ 500 px high).
  - A tablet is neither, so these two options apply to phones only.
- **Tested** on the scratch DB:
  - A page with a styled element was saved through the API. A script address and an out-of-range blur were refused.
  - On the published page, the computed styles matched: the gradient over the image, contain/top, 240 px height, min width, max height, the inset custom shadow, overflow hidden and the hand pointer.
  - The upright-phone element was hidden at 390×844, and the sideways one at 844×390.
  - In the editor, in Arabic and English, every value read back. Changing the pointer and saving stored it.
  - The test page was deleted and the site rolled back to its previous published version.
- **Scratch only:** the test server runs with a higher request limit (`RATE_LIMIT_MAX`). The editor makes enough calls that browser runs hit the normal 100 per minute.
Builder elements can have an entrance animation (SPEC §9.3 Style tab).

- **Options:**
  - Type: fade, slide up, slide down, slide in from the start or the end, zoom in, zoom out.
  - A duration (100–3000 ms, default 600) and a delay (0–5000 ms).
  - It plays once, when the element first scrolls into view.
- **Where it lives:**
  - Stored as `settings.animation`, validated in `pages/elementAnimation.js`.
  - The store wraps the element (`data-za` plus timing variables). A small observer, `EntranceAnimations.tsx`, is shipped only on pages that use animations, and reveals each element.
  - In the editor it is the "Entrance animation" part of the Style tab.
- **Decision: one animation for every device.**
  - It describes how the element arrives, not its per-device look.
  - "Start" and "end" follow the page direction, so in Arabic, start is the right side.
- **Decision: never lose content to an animation.**
  - Shoppers who ask their device for less motion see the element at once.
  - Without JavaScript a noscript rule shows it.
  - If the browser lacks IntersectionObserver, everything is revealed.
- **Tested** on the scratch DB:
  - A page with a top element and two lower ones was published.
  - The top element appeared at once. The lower ones were hidden (opacity 0; offset +32 px in Arabic, −32 px in English) until scrolled to, then revealed.
  - With reduced motion and with JavaScript off, they were visible straight away.
  - In the editor, in Arabic and English, the stored animation read back, a change to zoom out with a 300 ms delay saved, and choosing "None" removed it.
  - The page was deleted and the site rolled back.
The store can use any Google font, or a font it uploads, for its text, its headings, or any single element (SPEC §9.3 font family; Lightfunnels' Google and uploaded fonts).

- **Font references:**
  - A font is referenced as `g:<Name>` (Google) or `c:<id>` (uploaded) wherever it is used:
    - `themeSettings.bodyFont` and `headingFont`, set from the store look panel's new "Your fonts" section, over the look's or theme's own font;
    - `style.fontFamily` on an element, per device, in the Style tab.
  - The editor offers 42 Google fonts: 24 Arabic-capable, then Latin-only. The list and the reference parsing live in `api-client/endpoints/storeFonts.ts`, shared by the dashboard and the store.
- **Uploaded fonts** (`modules/fonts/storeFonts.js`):
  - WOFF2, WOFF, TTF or OTF, decided by the file's signature, up to 2 MB, at most 10 per store.
  - They are kept in `settings.store_fonts`, and their names reach the store in `GET /store/:ws` (`customFonts`).
- **Decision: uploaded fonts are served through the public store API** (`GET /store/:ws/fonts/:id`).
  - A browser fetches fonts under cross-site rules, and the store may be on any custom domain.
  - The response allows any origin and is cached for a year. Behind it is local disk or R2 (`getStorage().get`).
- **Decision: the store's chosen fonts survive a theme switch.**
  - They are an explicit choice, unlike the look's own font pairing.
  - Arabic text in a Latin-only font falls back to Tajawal.
- **Safe CSS:** only names matching the reference patterns reach CSS (letters, digits and spaces; 12 hex digits). Anything else is refused by the backend and ignored by the store.
- **Live preview:** unsaved body and heading fonts show at once (`components/preview/fontPreview.ts`). A font change now counts as an unsaved look.
- **Store security policy (development only):** fonts may also come from the local http hosts, as scripts already could. Production serves the API over https, which the policy allows.
- **Tested** on the scratch DB:
  - **Uploads:** a WOFF2 and a TTF were accepted; a PNG named as a font and an upload without a name were refused.
  - **Public link:** the font came back as `font/woff2` with `Access-Control-Allow-Origin: *` and a one-year cache; an unknown id gave 404 and a malformed one 422.
  - **Editor, store look:** the editor listed the two uploads above the Google groups. Choosing the upload for body text and Lalezar for headings updated the live preview's variables, link and @font-face, and saving stored `c:…` and `g:Lalezar`.
  - **Store page:** the wrapper carried both fonts. Elements rendered in Cairo and in the uploaded font, with the mobile override in Amiri on a phone. The uploaded fonts were fetched (200) and reported "loaded".
  - **Google Fonts:** they could not load here, because this sandbox's network blocks fonts.googleapis.com (the existing Fraunces link fails the same way).
  - **Element font:** the choice read back and saved, in Arabic and English.
  - **Cleanup:** the test page, the uploads, the settings and the site version were all restored.

## P0 — correctness, compliance, launch gates

- [x] 1. Events that never fire: record `order.unreachable`, `order.postponed`
  (confirmation outcomes), `order.returned` (shipment returned),
  `order.payment_failed` (online payment failed); send the server Purchase of an
  online-paid order on `order.paid`; the digital-delivery email listens for
  `digital.delivered` but the event is `order.digital_delivered`.
- [x] 2. Marketing messages respect opt-out and the blocklist: a STOP reply is
  recorded even for a customer who never opted in (`customers.marketing_opted_out_at`);
  recovery / review-request / lead automations skip opted-out and blocked
  phones; recovery tokens `{{product_name}}`, `{{cart_total}}` work for lost
  checkouts; ready-made recovery text says how to stop.
- [x] 3. Automations on customers, not only orders: `lead.created` (newsletter,
  forms, funnel opt-in) and `subscription.renewal_failed` (the service records
  `subscription.payment_failed`) reach the automations engine.
- [x] 4. Carrier sandbox adapter + README of the carrier contract +
  `POST /dev/sandbox/shipments/:id/advance` (Gate 2 depends on it).
- [x] 5. `requestId` on every log line (request context in the logger).
- [x] 6. Storefront cache: 60 s on `GET /store/:ws` and products, invalidated on
  `product.updated` / `funnel.published`; storefront ISR that actually revalidates.
- [x] 7. Background work in the worker: `ads.sync_spend` and `fx.update_rates` as
  queue schedules, not `setInterval` in every API process; the duplicate upload
  sweep timer removed. (Courier booking: see Decisions.)
- [x] 8. Error reporting (§3.5 Sentry, backend + worker; the dashboards and the storefront are not wired yet): an error-reporter interface, console by
  default, Sentry when `SENTRY_DSN` is set.
- [x] 9. Refresh token in an httpOnly cookie in production (§3.4 #2): already built,
  behind `AUTH_REFRESH_COOKIE=true` — an owner setting, because the cookie only
  works once the dashboard and the API share a site (app.x + api.x). Nothing to
  code; turn it on with the deploy.
- [x] 10. Shipping data (10a shipment_events, 10b per-account booking settings + automatic booking, 10c geo_regions + carrier_region_map, 10d bulk ship batches): `geo_regions` seed (Egypt + North Coast + districts,
  Saudi regions), `carrier_region_map` (stored, editable), `shipment_events`
  timeline, per-carrier-account `autoCreateShipmentOn` / inspection / courier
  notes; bulk ship shows ready vs missing-mapping and retries failures.

## P1 — Phase 1/2 features still missing

- [x] 11. Orders list (11a search by waybill, the filters below, date shortcuts and risk tab counts; 11b columns IP country / data quality / shipping / address, reorderable; 11c bulk invoices, webhook resend, export selected): search by waybill; filters dataQuality, ipCountry,
  discount code, utm source/campaign, funnel, product control, date shortcuts;
  columns IP country / data quality / shipping / address, reorderable; risk tab
  counts; bulk print invoices, resend webhook, export selected.
- [x] 12. Order page (12a whatsapp-confirm, 12b customer card copy/link/block/edit + map link, 12c coupon + bundle card, 12d cancel with refund + notify, refund notify): `POST /orders/:id/whatsapp-confirm` (template with buttons
  when WhatsApp is connected); customer card copy/link/block/edit; map link;
  coupon + bundle discount card; cancel with refund + notify; refund notify.
- [x] 13. Lost orders capture on a name or any valid phone for the store's
  country, 800 ms debounce.
- [x] 14. Webhook topics `checkout.created` / `checkout.updated` (`lead.created` is recorded since item 3).
- [x] 15. Payments (15a shopper consent to save a card + one-click upsell charge; 15b funnel currency applied; 15c display currency switcher + `currency_converter` element; 15d base amounts in attribution/P&L): funnel currency applied to orders, storefront display
  currency switcher, `currency_converter` element, base amounts in
  attribution/P&L; shopper consent to save a card and one-click upsell charge.
- [x] 16. Lead pixel event from the newsletter form.
- [x] 17. Notifications: integration-failed for gateway / carrier / WhatsApp (17a);
  export ready (17b).
- [x] 18. Analytics: `analytics_daily` rollup filled by the worker (18a); attribution
  from `orders.attribution` with first/last touch (18b).
- [x] 19. Team screen admins/members + seat counter (19a); phone verification screen (19b);
  2FA code over WhatsApp (19c); account settings (timezone, contact-form email,
  legal company/country (19d1), owner picture (19d2)); plan limits on leads and storage (19e).
- [x] 20. Digital delivery link on the thank-you page and by message.
- [x] 21. AI: apply a generated funnel as funnel steps; AI entry points in the
  product form and the funnel wizard.
- [x] 22. Shipping profiles + products.shippingProfileId (22a); shipping options the
  shopper chooses between.
- [x] 23. Merchant PWA web push + `device_tokens`.

## P2

- [x] 24. Orders pipeline (kanban) page; refresh button (24a); saved views per user (24b).
- [x] 25. Lost orders product filter and bulk delete.
- [x] 26. Carriers screen tabs, search, country filter; manifest.
- [x] 27. Installed apps gate their features; support access enforced for admins.
- [x] 28. Platform admin: carrier city mapping, theme catalog (theme catalog with 47).
- [x] 29. Contacts: segments in automations; tags from funnel buttons.
- [x] 30. Store PWA; ZIMOS referral program screen for merchants.
- [x] 31. Customer service bot (§19.3) on the sandbox AI provider.
- [x] 32. Inbox "Create order" opens a pre-filled new order.

## P1 — §7–§10 (catalog, store design, funnels, offers)

- [x] 33. Cross-sell at checkout and on the thank-you page (the dashboard offers
  both, the store shows only the cart); `add_to_cart` with `source=cross_sell`.
- [x] 34. Product order bumps on `/checkout` (only the store-wide bump shows).
- [x] 35. Product list uses the backend filters (collection, sku, type, stock)
  and server search; created date, "Not tracked", preview in store.
- [x] 36. Product SEO fields in the product form (backend and store read them).
- [x] 37. Storefront honours `auto_select_variant`, `landing_page_id`; a
  related-products section that `hide_related_products` can hide.
- [x] 38. Funnel runtime uses the funnel's currency, favicon and title (ties to 15).
- [x] 39. Custom-field answers on the waybill; `priceDeltaAmount`.
- [x] 40. Shopper review form with a photo; reviews import (Shopify) on the
  sandbox; public review endpoint must not reveal purchases by phone.
- [x] 41. Translations of pages and funnels; "Translate with AI"; server-side
  `<html lang dir>` for the store (SEO).
- [x] 42. Page settings in the builder: SEO and Scripts tabs.
- [x] 43. Funnel map editor (pan/zoom, link points per button, thumbnails,
  stats); wizard with currency step and template gallery.
- [x] 44. Missing builder elements (container, popup, image_gallery,
  variant_selector, bundle_selector, review_form, checkout elements…).
- [x] 45. Funnel analytics: EPC, per-page CTR/CR/opt-ins (events carry stepKey).
- [x] 46. Product video (mp4) upload.
- [x] 47. Themes catalog (`themes`, `workspace_themes`) instead of presets.
- [x] 48. Product-page A/B tests (`subjectType=product_page`).
- [x] 49. Custom code (§8.4) exercised end to end; head code server-rendered.
- [x] 50. Front-end error reporting (§3.5): the dashboards and the storefront report to Sentry.

## Second pass (2026-10-04) — five audits of §3–§20 against the code

Bugs and security first, then what blocks selling, then features.

- [x] 51. The old `/shop/:ws/checkout` (quickstart) skips the bot guard, store-wide OTP and lost-order capture the store checkout has.
- [x] 52. Platform WhatsApp channel: production `console` reports codes as sent (no SMS fallback) and logs them unredacted; a Cloud API adapter + sandbox + README.
- [x] 53. Phone masking (§3.4 #8) on the lost-orders list/export and the suspicious-orders list too.
- [x] 54. `{{payment_link}}` carries the payment token; the payment-failed template waits an hour (§11.4).
- [x] 55. Hidden products left out of sitemap.xml (§7.3).
- [x] 56. The store-wide "pre-select a variant" switch is read by the product page (§7.2, §8.8).
- [x] 57. The builder countdown counts to a fixed date, never restarting per visitor (§9.3, §21).
- [x] 58. Funnels take every payment method the store offers: the COD form in a funnel, online and transfer payments in the funnel checkout, payment methods per funnel honoured (§9.2, §11.4).
- [x] 59. The product-page buy box completes manual transfers and deposits (§11.3).
- [x] 60. Coupons in the funnel checkout: the code field, `?coupon=`, funnel-limited coupons (§9.3, §10.5).
- [x] 61. The store's currency (set until the first order) and its format settings used by the storefront (§8.8, §11.5).
- [x] 62. Store product pages send ViewContent / InitiateCheckout / bundle AddToCart; one content id everywhere (§13.2).
- [x] 63. Server-side Purchase carries matching data (IP, user agent, fbp/fbc, ttclid, name, city, country) and contents (§13.2).
- [x] 64. The recovery link applies the automation's coupon (§6.4).
- [x] 65. Bulk actions on "all filter results" in the orders list (§4.3).
- [x] 66. Order page: pages visited, time to purchase, the customer's order count and "New customer", last action in the header (§4.2–§4.4).
- [x] 67. "Save as draft" on the order's shipping card (§4.4).
- [x] 68. The missing outbox events: order.item_added, customer.updated, product.low_stock, review.created (§3.2).
- [x] 69. Policies shown in funnels (§8.3).
- [x] 70. Category SEO (title, description, OG image, noindex) used by the store; the categories list's preview / in-header / export (§7.6, §8.9).
- [x] 71. The primary domain is the store's canonical address: canonical, sitemap and feed links, redirect (§8.11).
- [x] 72. The store country setting drives the order form's country (§8.8).
- [x] 73. A variant's own image (§7.2).
- [x] 74. Upsell/downsell: the shopper picks the variant, the offer's countdown, card orders get the thank-you upsell (§9.5, §10.4).
- [x] 75. Funnel settings: change the link, funnel-wide scripts, a shipping group per funnel (§9.7).
- [x] 76. The funnel issues counter checks untranslated text (§9.2).
- [x] 77. Offers hub numbers: impressions, acceptances, added revenue per offer (§10.11).
- [x] 78. "Create product with AI" takes product photos (§19.2).
- [x] 79. Subscription / instalment products in the store: the plan shown, COD refused, the card saved (§18.1).
- [x] 80. Subscriptions: free trial, card update in the portal, a ready "renewal failed" message (§18.1).
- [x] 81. `ad_id` from ad links recorded and matched to spend (§15.4).
- [x] 82. App store: Clarity and Google Merchant shown as available (§16.6).
- [x] 83. Changing the owner's email, verified (§17.3).
- [x] 84. Education: tutorial links by key settings, help center and Telegram cards on the home page (§15.1, §18.6).
- [x] 85. WhatsApp templates synced from Meta with their status, picked in automations and the inbox (§14.1).
- [x] 86. Product and funnel pickers for automation conditions (§14.2).
- [x] 87. Order emails: the store's From name and Reply-To (§14.5).
- [x] 88. WhatsApp as a merchant notification channel (§14.6).
- [x] 89. Paymob valU and Kiosk (§11.2).
- [x] 90. Lost orders: the WhatsApp row action sends the recovery template through the connected number (§6.3).
- [x] 91. French in the storefront interface (§8.10).
- [x] 92. A positioned custom HTML block in the builder, stored outside the tree (§8.2, §8.4).
- [x] 93. Builder elements: masonry grid, sticky container, file and star inputs in forms, add-to-cart / buy-now buttons, a price that follows the picked variant (§9.3).
- [x] 94. The funnel page editor gets the website editor's tools: undo/redo, layers, page product, named styles, saved sections (§9.3).
- [x] 95. Both editors: double-click text editing, X-ray outlines, duplicate element/section (§9.3).
- [x] 96. Generic pages (contact, about, policies) outside the funnel map (§9.2).
- [x] 97. AI P2: page evaluation, ad creatives, build a full store, suggested WhatsApp replies (§19.2).
- [x] 98. Large digital files uploaded straight to storage (presigned multipart) (§18.2).
- [x] 99. Remove the leftover mock upsell page and helpers (§9.8).
- [x] 100. Theme gallery: reset the current theme, theme tags (§8.1).

## Third pass (2026-10-04) — five audits of §3–§20 against the code

Same order: bugs and security first, then what blocks selling, then features. Left out on purpose: store-wide named styles (lane 5 decision), per-device column widths (the full style/layout tab list is not queued), a per-product currency (the store has one currency, decision 61).

- [x] 101. Store templates carry no other store's contact details: the Uokids template's WhatsApp number, address, email and social links removed (and from stores that got them), and the floating WhatsApp, footer contact and social links editable in the dashboard (§8.2, §8.8).
- [x] 102. The orders export masks phones unless the teammate may reveal them (§3.4 #8).
- [x] 103. The checkout autosave goes through the bot guard and keeps the shopper's IP and country (§5.1, §6.1).
- [x] 104. "Switch to cash on delivery" on the pay page runs the COD checks: OTP, deposit, the per-IP rule, the funnel's payment methods (§11.4, §5.6).
- [x] 105. The abandoned-cart email respects STOP and the blocklist (§14.5).
- [x] 106. Ending a session (one device, all devices, password reset) cuts access at once (§17.2).
- [x] 107. Two-step sign-in recovery: backup codes, a reset by the platform, and what a password reset does (§17.2).
- [x] 108. A code on sign-in from a new device, and a "new sign-in" alert (§17.2).
- [x] 109. Countdowns stay fixed on split-test pages and in linked saved sections (§9.3, §21).
- [x] 110. The opt-in step collects the visitor's details before moving on; Lead and the opt-ins count follow real sign-ups (§9.2, §9.9).
- [x] 111. Linked saved sections update inside funnels; funnel-only saved sections (§9.3).
- [x] 112. A paid order's subscription and course enrolment start through the outbox, never lost after payment (§3.2).
- [x] 113. "Powered by ZIMOS" honours remove_branding on funnels and the rich footer (§8.11).
- [x] 114. No invented shipping, returns or COD promises: the product tab, FAQ fallback, trust strip and footer help read the store's own information (§8.5).
- [x] 115. The rich footer shows the policy links, footer pages and social links (§8.3).
- [x] 116. Automation conditions work on checkout, lost-order, lead and subscription triggers (§14.2).
- [x] 117. Trial subscriptions shown and counted in the subscriptions screen (§18.1).
- [x] 118. "Convert to order" keeps the coupon, the funnel and the custom answers, and cannot create two orders (§6.3).
- [x] 119. Recovery automations mark the lost order contacted; the ready-made recovery timing as the spec says (§6.4).
- [x] 120. The tracking page accepts the store's own country's phones (§14.7).
- [x] 121. The store's country on the server: phones, OTP, the risk score and allowed countries (§5.2, §5.5).
- [x] 122. Payment methods offered only when they take the order's currency; payment fees, shipping and the free-shipping threshold in the funnel's currency (§11.5).
- [x] 123. Shipping prices by region from the platform's places: North Coast, Saudi regions, hiding a region, one price for all (§12.1).
- [x] 124. Root domains and www: an A/ALIAS record option and the www redirect (§8.11).
- [x] 125. Product feed items land on their own variant (§7.8).
- [x] 126. An order bump on a funnel product page's COD form, and the product's own bumps there (§9.5, §10.3).
- [x] 127. COD settlement statements read from the courier's Excel file (§15.5).
- [x] 128. The builder product list's "Featured" and "Best selling" sources honoured (§8.2).
- [x] 129. A failed payment marks the order and fires the event, also when the gateway refuses to start it (§11.4).
- [x] 130. A rejected transfer: the shopper is told and can upload a new receipt (§11.3).
- [x] 131. The deposit rule reads the platform-wide delivery rate (§11.3).
- [x] 132. Lost orders keep their traffic source (§6.1).
- [x] 133. The merchant sets when a checkout counts as lost (§6.2).
- [x] 134. "Notify the customer" on status changes, one order or many (§4.6).
- [x] 135. The order timeline shows the messages sent to the customer (§4.4).
- [x] 136. Orders list and order page: product images, the funnel's name as the source, "New customer" (§4.3, §4.4).
- [x] 137. Dropship: send an order to the supplier from the order page, forward automatically, follow its status (§16.5).
- [x] 138. The order.status_changed webhook carries old_status and new_status (§16.1).
- [x] 139. Contact tags from purchase buttons on website pages too (§18.4).
- [x] 140. Subscribers get their portal link (§18.1).
- [x] 141. The store's subdomain can be changed in settings (§17.3).
- [x] 142. New-order notifications name the product and governorate, in the teammate's language (§20.1).
- [x] 143. AI store policies applied to the store's policies (§19.2).
- [x] 144. Product pickers in the builder instead of pasted IDs, with "Edit product" (§9.3).
- [x] 145. Funnel page editor: tablet preview, previous/next page, select the parent element (§9.3).
- [x] 146. Split tests with more than two versions (§9.6).
- [x] 147. Copy a coupon's share link (§10.5).
- [x] 148. Page settings Details tab: a generic page's address and its title (§9.3).
- [x] 149. Translations for product content, offer text, option values, policies, store info, the thank-you text and menu labels (§8.10).
- [x] 150. Formatted product descriptions, sanitized (§7.1).
- [x] 151. A "track quantity" switch for physical products; variant prices labelled in the store's currency (§7.1).
- [x] 152. A currency switcher on attribution, reports and profit (§11.5).
- [x] 153. Order export presets in a courier's own layout (§12.3).
- [x] 154. The Pinterest tag (§13.1).
- [x] 155. Google Sheets sync for orders and lost orders: adapter + sandbox + README (§16.4).
- [x] 156. The dashboard home remembers its period; bulk tagging from the contacts list (§15.1, §18.4).

Not queued (decided already or waiting on the owner): cross-sell discounts and "once per customer" by phone/email (lane 3), the full style/layout tab list (lane 5), city/district shipping prices (decision 19 keeps the city as free text), service ratings (lane 8: no fake ratings), a niche-template wizard card (decision 75).

§5 (fraud) and §22 Gate 1 (no mock pages, no mockCommerce.ts) are complete.

## Fourth pass (2026-10-06) — Lightfunnels parity

The owner, 2026-10-06: "كمل كل حاجه ناقصه … عايز يبقي لايت فانل … تضيفلي كل الفيتشرز اللي هناك ما عدا لايت اسكول". Every Lightfunnels feature except LightSchool (their school/course product) is in scope, plus what the platform still lacks. Built the same way as the passes above.

How the list was made:
- Lightfunnels' features were gathered from their help center, API reference and app store (search excerpts; this environment's network blocks their hosts). They were compared with an inventory of both repos.
- What we already match is not listed. That covers the funnel canvas, step types, split tests, one-click upsells, price bundles, bumps, payment-method fees, smart sections, data binding and repeater, reviews, personalization, digital products, abandoned checkouts, Google Sheets, feeds, pixels with server events, geo redirects, the fraud guards, domains, currencies and multi-store.

Rules that still hold:
- SPEC §21 still holds, so cloaks, evergreen timers and AI-written reviews (all in Lightfunnels) are not built.
- An outside service is an interface, a `sandbox` adapter and a README; a real adapter needs the owner's keys to be verified.
- Earlier "not queued" items that Lightfunnels has are queued now at the owner's request: the full Style tab (lane 5) and city/area places with prices (decision 19).

Migrations for this pass: **450–499**.

Design (page builder):
- [x] 157. The full element Style tab (SPEC §9.3): background gradient and image, height and min/max sizes, custom shadow (inner/outer, x, y, blur, spread, colour), overflow, cursor, and visibility on mobile portrait/landscape.
- [x] 158. Entrance animations per element (fade, slide, zoom; delay, duration; respects reduced motion).
- [x] 159. Fonts: Google Fonts for the store and per element, plus the merchant's uploaded fonts (woff2).
- [x] 160. Editable storefront texts per language: button labels, form errors, cart/checkout/bundle wording. (backend done, UI in frontend-handoff.md)
  - Only overrides are stored, in `settings.storefront_texts` = { locale: { "section.key": text } }; the defaults stay in the storefront dictionary, so new storefront labels need no backend change.
  - Languages are the translation module's list (ar, en, fr, es, it, de), not only ar/en/fr, so a store's extra languages can be reworded too.
  - Keys are checked by shape (2–4 dot parts), not against a list: the dictionary lives in the frontend repo and changes there; the storefront ignores unknown keys.
  - PUT replaces the whole object; a blank text drops the override. Plain text only, 500 characters, 400 per language; `{arg}` placeholders kept for function entries.
  - `GET /store/:ws` exposes every language as `storefrontTexts` (small, cached 60 s like `customFonts`); the storefront picks the shopper's.
- [x] 161. Store scripts targeted by position (head, body start, body end) and by page type (all, home, collection, product, checkout, thank you). (backend done, UI in frontend-handoff.md)
  - Each script is a `workspace_custom_code` row (slot `ss:<id>`), with name/position/pages/sort order in a new `options` JSONB column (migration 450), so the custom code's rules (website.publish, audit, no preview, own host only, never on payment pages) apply unchanged.
  - Page types add `page` (custom pages), `funnel` (funnel steps) and `cart` to Lightfunnels' list; `"all"` sent with others collapses to `["all"]`.
  - At most 30 scripts, 50 000 characters each (the slot limit); the count is checked under the workspace lock.
  - The public custom-code read returns them as `scripts` beside the existing `slots`; the existing fixed slots stay as they are.

Commerce:
- [x] 162. Smart collections by product tags (any/all), and a default "all products" collection. (backend done, UI in frontend-handoff.md)
  - Uses the existing `collections.rules` column (no migration). Membership is kept as ordinary `product_collections` links, filled by model hooks in the same transaction, so every reader of a collection works unchanged.
  - Tags match case-insensitively; at most 20 tags per rule.
  - A smart collection refuses hand-added or hand-removed products (409 `SMART_COLLECTION`), single and bulk; reordering stays. Duplicating a product skips copying smart links (the hook already linked the copy).
  - "All products" is made with one click (slug `all`, idempotent) rather than for every store at sign-up, so workspace creation is untouched. A store copy (bulkCreate) keeps its copied links; `POST …/sync` repairs any collection by hand.
- [x] 163. The store's own places: regions → cities → areas per country, imported from CSV, with three-level pickers at checkout. (backend done, UI in frontend-handoff.md)
  - New table `store_places` (migration 451), one row per region/city/area, parent links with cascade delete; at most 5000 per country.
  - A region or city keeps the platform's code (`geo_code`) when `geoRegions.resolve` finds its name, so governorate prices, hidden places and courier area maps keep applying to addresses picked from the store's list.
  - Import reads CSV or .xlsx through the catalog's sheet reader (no new dependency); `merge` reuses names already there, `replace` clears the country first. "Start from the platform list" is the same import fed from `geo_regions`.
  - The public list falls back to the platform's governorates and cities when the store has none, so every checkout has pickers.
  - Addresses take `area` and `placeId` (checkout, lost orders, staff orders); they are stored with the order's address. Pricing by place is item 164.
- [x] 164. Shipping prices per city and area, from a CSV or the places list. (backend done, UI in frontend-handoff.md)
  - The price lives on the place itself (`store_places.shipping_amount`, migration 452), minor units, null = not priced here. The deepest priced place of the address wins (area → city → region), ahead of the governorate price; otherwise pricing is unchanged.
  - Applied in the "rates" pricing mode only; weight tiers and shipping groups keep their own tables. A funnel in its own currency keeps its group's price.
  - Addresses are read by `placeId`, else by names, so staff orders, order edits and quotes are priced the same way (`calculateShippingAmount` now takes the whole `address`).
  - Sheet prices are in major units (what merchants type), converted with two minor digits; a bulk `PUT …/prices` saves the prices table.
  - A hidden place of the store's list, or an unknown `placeId`, is refused at checkout.
  - Platform cities get prices by copying the platform list into the store's list (item 163), rather than a second price table.
- [x] 165. A file-upload field in the checkout form, and an optional billing address ("same as shipping"). (backend done, UI in frontend-handoff.md)
  - The file field is a custom field type `file` in the existing form builder; the answer is a shopper-upload id, checked to be this visitor's (X-Visitor-Id), pending and unexpired, and attached to the order once it exists (`checkout/checkoutExtras.js`).
  - Photos only (JPEG/PNG/WebP, re-encoded), as for page forms: other files have no step that makes a stranger's file safe to open in the dashboard.
  - The order keeps the photo in `checkoutFields` as `{ type: 'file', uploadId }`; the order page adds a signed link per read.
  - Billing: `checkout_settings.billing_address` on/off; unticked "same as shipping" requires country, city and address line. Stored only when different (`orders.billing_address_snapshot`, migration 453); null means same as shipping.
  - Attaching and storing run after the order commits and never fail it (like the form answers).
- [x] 166. Bulk actions on funnels: publish, pause, duplicate and delete several at once. (backend done, UI in frontend-handoff.md)
  - One endpoint, `POST /funnels/bulk`, with resume added beside the four listed. Each funnel runs through its own button's service call, in its own transaction, so one refusal never blocks the rest; the answer reports each one (the orders bulk shape).
  - Guards follow the single actions: funnels.publish (+ live store for publish/resume), funnels.manage (+ creation allowed for duplicate). Up to 50 funnels per call.
  - Copies take the default "(copy)" name and a fresh subdomain, and count against the plan like single copies.

Tracking and analytics:
- [x] 167. "Send Lead instead of Purchase" per funnel and store (COD stores optimising on leads). (backend done, UI in frontend-handoff.md)
  - Store: `settings.conversion_event` (purchase default | lead), saved with the purchase-timing settings. Funnel: `settings.conversionEvent` (null = store's), on the funnel settings endpoint; the order's funnel wins.
  - Only the event name changes (`marketing/conversionEvent.js` holds each platform's names: Meta Lead, TikTok SubmitForm, Snapchat SIGN_UP, GA4 generate_lead, Pinterest lead); timing, value, event id, the once-only claim and the log stay as they are. The log records `lead` or `purchase`.
  - The providers take an optional `eventName`, defaulting to their purchase name, so nothing else that calls them changes.
- [x] 168. Pinterest Conversions API, using an ad account id and token. This reverses item 154's browser-only decision at the owner's request. (backend done, UI in frontend-handoff.md)
  - New provider `marketing/pixelProviders/pinterestCapi.js` with its README; the `pinterest` pixel platform turns `capi` and test events on. The ad account id lives in the pixel's `config.adAccountId` (no migration) and is required to switch the Conversions API on.
  - Sandbox by default (`PINTEREST_CAPI_MODE` unset): the body is built, checked and logged, nothing is sent; `live` sends it. The owner switches it once a real account has been checked.
  - Order conversion goes as `checkout` (or `lead`, item 167); relayed browser events map to `page_visit`, `add_to_cart` and `lead`; Pinterest has no checkout-start or payment-info event, so those are skipped for it.
  - Hashing, event id (the order id), value as a string in major units, as the README states.
- [x] 169. Google Ads purchase conversions with a conversion label (`send_to AW-…/label`). (backend done, UI in frontend-handoff.md)
  - The purchase label was already stored and served (item 132). Added a lead label for item 167, a ready `sendTo` { purchase, lead } in the public pixel list, and a server check that labels go only with an AW- id.
  - Browser only: the storefront fires `conversion` with `transaction_id` = the order id. Server-side Google Ads conversions (offline upload) need a developer token and an OAuth app, so they are left to the integrations team with the owner's account.
- [x] 170. Google Tag Manager: a ready-made container to import (triggers and tags for the store's events), with the dataLayer events listed. (backend done, UI in frontend-handoff.md)
  - Built on demand (`marketing/gtmContainer.js`), not stored: GTM's export format v2 with dataLayer variables, one Custom Event trigger per storefront event, GA4 tags and Google Ads conversions from the store's own Google pixels (or ids passed in the query).
  - Meta, TikTok and Snapchat tags are left out on purpose: the store already loads them, and copies in GTM would count every event twice.
  - The storefront is asked to push `event_id` and an `ecommerce: null` reset, and `generate_lead` for stores reporting leads.
- [x] 171. Live View on a world map: visitors, checkouts and orders from the last 10 minutes. (backend done, UI in frontend-handoff.md)
  - One read (`analytics/liveMap.js`), computed live from analytics sessions/events, open checkouts and sale orders; window 1–60 minutes, funnel filter as on the realtime page.
  - Aggregated by country and place, not per person: no coordinates or ids leave the server. Egyptian governorates and Saudi regions carry the platform place code, so Arabic and English names of one place merge and the dashboard can place a dot without a geocoder.
  - The dashboard draws its own map from ISO codes; no map-tile provider is added.
- [x] 172. Dashboard home: filter by product and by store, beside the funnel filter. (backend done, UI in frontend-handoff.md)
  - "Store" is a website of the workspace (`orders.website_id`, `analytics_events.website_id`); the workspace itself is already the store the dashboard shows, and switching workspaces stays the way to see another one.
  - Product: orders with a line of it, abandoned checkouts holding it. Visits and funnel steps cannot be split by product, so they stay store-wide and the answer says `eventScope: "store"`.
  - A website filter counts events from raw rows (the daily rollup is per store and funnel only). Filtered views keep the quick profit estimate, as funnels do.

Email:
- [x] 173. A sending domain for customer emails: DNS records shown, then verified (interface + sandbox). (backend done, UI in frontend-handoff.md)
  - `emailDomains/`: a provider interface, a sandbox adapter and a README. The sandbox hands out SPF/DKIM/return-path/DMARC records and checks them with real DNS lookups; reserved test TLDs always verify. A Brevo adapter (the platform's mail service) is described in the README, to be checked against the owner's account.
  - Stored in `settings.email_sending_domain` (no migration); one domain per store, refused when another store has it.
  - Only a verified domain changes the From address (`orderEmailSender.senderFor` → `notify.email` → Brevo `sender.email`); a later failed check falls back to the platform's address.
- [x] 174. A block email designer (heading, text, button, image, order table, divider) for order emails and cart recovery. (backend done, UI in frontend-handoff.md)
  - Blocks are JSON on the existing template row (`order_email_templates.blocks`, migration 455); null keeps the plain body, so nothing changes for stores that do not use it.
  - Rendered only on the server (`notifications/emailBlocks.js`): every text escaped after the {{variables}} are filled, links limited to http(s) or a variable, so no merchant HTML reaches a customer.
  - The order table reads the order's own lines (or the cart's, for recovery), with shipping and total; previews and tests use sample lines. The branded header, footer and unsubscribe line wrap blocks as they wrap text.
- [x] 175. Order emails chosen per funnel or store, instead of one set per store. (backend done, UI in frontend-handoff.md)
  - A `scope` on the existing template rows (migration 456: '' = the store's set, `funnel:<id>`, `website:<id>`), unique per workspace, key and scope. "Store" here is a website of the workspace, as in item 172.
  - An override keeps its own on/off; its empty subject, body or blocks come from the store's version, so a merchant can change only the subject for one funnel.
  - An order picks its funnel's override, then its website's, then the store's; cart recovery reads them from the checkout's attribution. Every endpoint takes `?funnelId=` / `?websiteId=`, and DELETE removes an override.

Domains and developers:
- [x] 176. Buy a domain in the dashboard: search, buy, automatic DNS, renewal (registrar interface + sandbox). (backend done, UI in frontend-handoff.md)
  - `domains/registrar/`: interface, sandbox adapter (availability from a real NS lookup; registers, sets DNS and renews only in the log) and README. A real registrar needs the owner's reseller account.
  - Prices are only the registrar's (sandbox: an env table); the merchant confirms the shown price and a different quote stops the purchase (409). Charging for the domain is left to billing (SPEC §22); nothing here takes money.
  - A bought domain is recorded in `domain_purchases` (migration 457), added to the store's domains and marked verified, since we set its DNS (routing records + the verification TXT). The plan's domain limit applies as for connected domains.
  - Auto-renew on by default; the daily `domains.renew_due` job renews in the last 30 days and marks lapsed ones expired.
- [x] 177. "Redirect to the primary domain" per domain. (backend done, UI in frontend-handoff.md)
  - `domains.redirect_to_primary` (migration 458), true by default so today's behaviour (every domain moves to the primary one) stays until a merchant turns it off.
  - Off: resolve-host answers no primary host for that domain, so the storefront proxy serves the store there with no proxy change; canonical links still name the primary domain.
  - The platform subdomain keeps moving to the primary domain; the www/root counterpart switch is unchanged.
- [x] 178. Webhooks: custom headers per endpoint, plus the topics `funnel.created/updated/deleted`, `payment.paid` and `contact.updated`. (backend done, UI in frontend-handoff.md)
  - Headers: `webhook_endpoints.custom_headers` (migration 459), values sealed with secretBox and only shown masked; a PATCH can keep a stored value by name. Zimos' own and transport headers cannot be set, and ours are applied last.
  - The new topics come from model hooks (`webhooks/modelEvents.js`) that record outbox events inside the change's transaction: funnel create/update/destroy, a payment saved as captured (once), and a customer's own fields (name, phone, email, tags, consent) — counters do not fire it.
  - `contact.updated` is the customers table read as contacts (SPEC §18.4); the older `customer.updated` topic is kept as listed.
  - Fixed: the funnel payload asked for a `slug` column funnels do not have, so `funnel.published` never delivered; it now reads `subdomain`.
- [x] 179. An MCP server for the store, used by Claude, ChatGPT or any MCP client with an API key: list products and orders, check pages for problems, create a draft funnel. (backend done, UI in frontend-handoff.md)
  - `POST /api/public/v1/mcp` (`modules/mcp/mcpServer.js`): JSON-RPC 2.0 on the MCP Streamable HTTP transport, answered as plain JSON with no event stream or session (GET → 405), written by hand rather than adding an SDK dependency.
  - Same rules as the public REST API: the store API key authenticates, its creator's role and its scopes must allow each tool, the per-key rate limit applies. Two scopes added: `funnels:read`, `funnels:write`.
  - Tools call the existing services only (catalog list, public order serializer, funnel issues, funnel create), so nothing bypasses their checks. Errors are tool results with `isError` so the assistant can read them.

Integrations (interface + sandbox + README):
- [x] 180. Import products and reviews from AliExpress, Etsy, CJ and YouCan links, as importer adapters beside Shopify. (backend done, UI in frontend-handoff.md)
  - `catalog/importExport/importers/`: a link → source registry, a structured-data reader (schema.org JSON-LD Product, Open Graph fallback) fetched with the Shopify importer's guard (https, public addresses, no redirects, size cap), a sandbox mode and a README naming the official-API adapters that need the owner's keys.
  - Products land through the existing import job as drafts with stock 0; the page's price is kept in its own currency and noted in the description for the merchant to check.
  - Reviews: only those the page publishes, `source: 'import'`, `status: 'pending'` until approved; the sandbox brings none, so no review is ever made up (SPEC §21).
  - This environment has no outside network, so live pages answered 403 here; the reader and the job were checked on a saved product page with JSON-LD and reviews.
- [x] 181. Send orders to a Shopify or WooCommerce store, and bring back fulfilment. (backend done, UI in frontend-handoff.md)
  - Two dropship providers (`dropship/providers/shopify.js`, `woocommerce.js`) on the existing contract, so connect, import, push, auto-forward, follow and apply-status all come for free; no new endpoint or migration.
  - Shopify: Admin API 2024-10 with a custom app token. Imported variants carry the Shopify variant id as SKU; other lines go as custom lines. Idempotent by `source_identifier = zimos-<orderId>`. fulfilled → shipped, delivered → delivered, cancelled → cancelled; tracking comes back too.
  - WooCommerce: REST v3 with a consumer key/secret. SKU `<productId>[:<variationId>]`; an unmappable line is refused (Woo orders need a product). Idempotent by meta `_zimos_order_id`. completed → shipped, cancelled/failed → cancelled, refunded → returned.
  - `storeHttp.js`: https only (plain http to localhost only outside production), timeout, no redirects, README error codes. Registered in production; the `sandbox` provider stays the test one.
  - Verified against a local mock store for both: bad token 422, import 404/201, push twice → same id, refresh → shipped.
- [x] 182. Sync contacts and leads to Mailchimp or Klaviyo lists. (backend done, UI in frontend-handoff.md)
  - New `emailMarketing/`: provider interface (README) + `mailchimp.js`, `klaviyo.js`, `sandbox.js` (outside production). Connections are `workspace_integrations` rows `email_marketing:<code>` with the key sealed; no migration.
  - Only contacts with an email, marketing consent and not blocked are sent; withdrawing consent (contact.updated) unsubscribes them. Sources: leads (no order) and/or buyers; store tags + the contact's own tags.
  - Live: consumer on lead.created / customer.created / contact.updated; "Sync now" is an io job (pages of 200, at most 20,000). Unreachable → outbox retry; refused → `lastError` on the card.
  - Mailchimp and Klaviyo became installable app-store apps (were "coming soon"); routes work only while installed. Adding a contact by hand now records customer.created, so it syncs (and reaches customer.created webhooks) too.
  - Verified with the sandbox (connect, lists, settings, live sync of the consented contact only, Sync now) and with stubbed fetch for the Mailchimp/Klaviyo request shapes.
- [x] 183. Express checkout buttons (wallets) and Stripe and PayPal adapters behind the payment interface. They stay sandbox until the owner's keys are set. (backend done, UI in frontend-handoff.md)
  - `payments/gateways/stripe.js` (Checkout Session; card with Apple Pay / Google Pay; test/live from the key; signed checkout.session webhooks over the raw body, which paymentEventService now passes as `rawBody`) and `paypal.js` (Orders v2; sandbox/live detected; captured by `inquire` once approved, idempotent; no webhooks since verifying them needs a call back).
  - New method `paypal` (migration 460 on the order enum, methodNames, export/invoice labels). PayPal takes USD/EUR/GBP/CAD/AUD only; Stripe the two-decimal currencies incl. EGP.
  - Express buttons = adapter `expressFor` → `express: { wallets }` on the storefront methods list; the button runs the normal checkout + redirect, so no new shopper endpoint. The sandbox gateway offers both, so the preview works with no keys ("sandbox until keys are set").
  - `gatewayHttp.request` takes `form` (form-encoded). `STRIPE_API_BASE`/`PAYPAL_API_BASE` point at a mock outside production.
  - Verified on a mock Stripe/PayPal: connect (bad pattern 422, bad key GATEWAY_AUTH_FAILED), methods list with express (PayPal only for USD), Stripe checkout → pay → return = paid → refund, webhook good/forged/stale/ignored; PayPal create → approve → capture → refund at adapter level.
- [x] 184. Address autocomplete at checkout (places-provider interface + sandbox). (backend done, UI in frontend-handoff.md)
  - `places/autocomplete/`: provider interface (README) + `builtin` (the store's places list or the platform's; no key, the default and the sandbox) + `google` (Places API New, the store's own key sealed, session tokens). No migration: setting in `workspace_integrations` `address_autocomplete`.
  - Public: /store/:ws/address/config|suggest|details. Every pick is matched back to the store's list (folded Arabic/English names) so pricing, hidden places and courier maps keep working; `placeId` set when a store place matches.
  - A refused Google key is shown to the merchant (`lastError`) and shoppers fall back to the built-in list instead of an error.
  - Verified: platform list (زايد, مدينه نصر, giza), store list with an added area (ar/en), Google on a mock (no key, bad key, suggest, details matched to the store's Nasr City), off.

What the platform still lacks (the owner's "كل حاجه ناقصه"):
- [x] 185. Shopper accounts: sign in by phone or email code, with order history, saved addresses and reorder. (backend done, UI in frontend-handoff.md)
  - `shopperAccounts/`: passwordless codes in `shopper_login_codes` (migration 461; HMAC per row, 10 min, 5 tries, superseded by the next; limits per address and per IP counted in the table). Unknown email gets no code and the same answer; a new phone becomes a contact on its first right code (customer.created).
  - Token = signed `ws.customer.accountVersion.expiry` (30 days), header X-Shopper-Token; "sign out everywhere" bumps `customers.account_version`. No server sessions.
  - Orders: own orders only (customer + store, not test, not archived), tracking-page view reused (presentTrackedOrder/trackingStage exported). Reorder returns cart lines with availability; the frontend fills the cart (no order is placed by the backend).
  - Addresses in `customers.saved_addresses` (max 10, one default). Off by default: `settings.shopper_accounts` (website.edit). Email/SMS use the store's name (new `shopper_login_code` email template).
  - Verified: off 404, codes + cooldown 429, wrong code count, verify, reuse refused, me/patch, addresses CRUD + default, orders/detail/reorder, foreign order 404, email sign-in, sign-out-everywhere 401, new phone contact.
- [x] 186. Shopper returns: ask for a return from the order tracking page, which feeds the existing returns flow. (backend done, UI in frontend-handoff.md)
  - `returns/shopperReturns.js`: public eligibility + request, the order named by the tracking token or by orderId + shopper token (185). Lands as a `requested` ReturnRequest with `source: shopper` (migration 462 adds `source`, `photo_upload_ids`); the merchant's approve/reject/restock flow is unchanged.
  - Off by default: `settings.shopper_returns` { enabled, windowDays 14, photoRequiredFor [damaged, defective] } (orders.manage). Window counts from the delivered shipment (or the fulfilled order). Returnable = ordered − quantities in other non-rejected returns.
  - Photos reuse customer uploads (same visitor id, attached on request); staff lists get signed photo links. Outbox `return.requested`.
  - Verified: off, not delivered, eligible, photo required, wrong visitor refused, request with photo, returnable shrinks, over-quantity refused, staff sees source + photo, all requested, window closed, bad token 404.
- [x] 187. Import contacts from CSV, with tags and marketing consent. (backend done, UI in frontend-handoff.md)
  - `contacts/contactImport.js` on the shared sheet reader (CSV or xlsx, 5000 rows, 5MB): columns by English or Arabic name, phone required, invalid emails/consent values reported but the row kept, duplicate phones merged. No migration.
  - Modes update (default) / skip; tags only added, never removed; extra tags for the whole file; dryRun for "Check file". New contacts `source: import` + customer.created; changes go through the model so contact.updated fires.
  - Consent only from each row (yes/no/empty) — never a switch that consents everyone.
  - Verified: template, missing phone column, Arabic headers, dry run saves nothing, real import, update + unchanged, skip mode.
- [x] 188. A wishlist for signed-in shoppers. (backend done, UI in frontend-handoff.md)
  - `shopperAccounts/wishlist.js` + `wishlist_items` (migration 463, unique per customer/product/variant with a COALESCE index), max 200. Needs shopper accounts on (185).
  - Guests keep hearts in the browser and merge them after sign-in (only products still for sale). Archived/out-of-stock items stay listed as unavailable; deleted products go by cascade.
  - Merchant `/wishlists/top` (products.view): most wished products by distinct shoppers.
  - Verified: off 404, no token 401, add, add twice no-op, variant entry, bad product 404, merge, top, remove, remove twice 404.
- [x] 189. Gift cards: issue, sell as a product, redeem at checkout, check the balance. (backend done, UI in frontend-handoff.md)
  - New `giftCards/` (README) + migration 464 (`gift_cards`, `gift_card_transactions`). Codes: HMAC for lookup, sealed for reveal/resend, last 4 shown.
  - Redeemed at checkout with cash on delivery only (online gateways charge the full total today; noted as a follow-up). The card is a captured `gift_card` payment, so COD collects total − card and the order is paid/partially paid.
  - Refunds: a Refund model hook credits the card in the refund's own transaction (merchant refunds and the automatic one on order.cancelled) — first built in a separate transaction, which deadlocked on the order row and double-credited on retries; fixed before commit. Locks are order first, then card.
  - Sold as a product: `settings.gift_cards.productIds` → one card per unit at the line's unit price on order.paid/order.delivered, idempotent per unit (unique index), emailed to the buyer; optional validity days.
  - Verified: issue + email, check (spacing/case) and 404, full and partial redemption, empty card refused, online refused, cancel returns the balance once, merchant refund credits, reveal, adjust, disable, list by last 4, sold cards issued once.
- [x] 190. A blog: a posts index, categories, and the latest posts on the home page. (backend done, UI in frontend-handoff.md)
  - New `blog/` module + migration 465 (`blog_categories`, `blog_posts`). Separate from the builder's `blog_post` page type: articles need excerpt, cover, dates, categories and an index.
  - Body = validated blocks (heading, paragraph, image, list, quote, product, button, divider); no HTML is stored or sanitised — the storefront renders text. URLs https (buttons may be store paths). Product blocks are filled live on read.
  - Scheduling without a job: published + future publishedAt is hidden until then. Slugs keep Arabic letters and get -2, -3 when taken.
  - Public index/post/categories/latest with 60 s cache; posts added to the store sitemap (noindex respected). Staff permission website.edit.
  - Verified: Arabic slugs, bad image URL and extra fields refused, publish/draft/scheduled states, slug conflict 409, public list/category/tag, product block filled, draft/scheduled 404, latest, sitemap, deleting a category keeps its posts.
- [x] 191. Element display rules: show between dates, and by device, country or UTM source. (backend done, UI in frontend-handoff.md)
  - `pages/displayRules.js`: `element.settings.visibility` validated in the page tree (store pages and funnel steps share it). No migration.
  - Dates are enforced server-side: public page and funnel-step payloads drop elements outside their window, so hidden offers/codes never reach the browser early.
  - Device/country/UTM are per visitor, so the cached page carries the rules and the storefront applies them, with `GET /store/:ws/visitor-context` (country from the IP lookup used by geo redirects, device from the user agent) and `evaluate` as the reference. Same page for every visitor of a kind — not a cloak (SPEC §21).
  - Verified: every invalid rule shape reported, a valid rule set accepted, past/future elements stripped and open/plain kept, evaluate cases (device, include/exclude with unknown country, UTM case-insensitive), visitor context.
- [x] 192. A template marketplace: merchants submit funnel templates (built on the share code), the platform reviews them, and others use them (no prices in code). (backend done, UI in frontend-handoff.md)
  - `marketplace/` + migration 466 (`marketplace_templates`): the funnel's steps and links are snapshotted at submission (products/offers/bumps removed with the share code's `withoutProducts`), so the author's later edits don't change what others copy until they resubmit.
  - States pending → approved / rejected (note required) → resubmit; withdraw any time; editing a listed card sends it back to review. One open submission per funnel.
  - Review in the platform console with the existing templates.view/manage permissions; merchants browse/use with funnels.manage. "Use" creates a draft funnel counted against the plan and bumps usesCount. Free only.
  - Verified: empty funnel refused, submit, duplicate 409, hidden before approval, non-admin 403, reject without note 422, reject → note visible → resubmit → approve, browse by category/tag, preview pages, use creates a draft, withdraw hides it. Test admin rights removed and test funnels deleted.

Not built, and why:
- **Cloaks:** SPEC §21.
- **Evergreen countdowns:** SPEC §21.
- **AI-written reviews:** SPEC §21.
- **The native mobile app:** a separate project. The dashboard installs as an app with push and live sales.
- **LightSchool:** excluded by the owner.
- **Square, Checkout.com, Razorpay, MercadoPago and CinetPay gateways:** these are new payment gateways, the integrations team's work per SPEC §22. The payment interface already takes them.
- **ShineOn and other print-on-demand services:** they would be new providers on the existing DropshipProvider interface.

## Fifth pass (2026-10-06) — what is still missing after the Lightfunnels list

How the list was made: after 160–192, the code was searched for the remaining features of Lightfunnels and of the stores
merchants compare it with (Zapier/Make app, stock alerts, pre-orders, consent, store gates, purchase limits, delivery
estimates, campaigns, reports). Only what is not in the code is listed. SPEC §21 still holds; outside services are an
interface + `sandbox` adapter + README; migrations stay in 450–499; no prices in code.

- [x] 193. Zapier / Make: REST-hook subscribe/unsubscribe on the public API (order created/paid/shipped, lead created, contact updated), sample-data endpoints for setting up a Zap, API-key auth and scopes. (backend done, UI in frontend-handoff.md)
  - Subscribe/unsubscribe already existed (public `POST/DELETE /webhooks`, scope webhooks:write). Added `GET /webhooks/samples/:event` built with the real delivery builder (webhookFanout.build, now exported) from recent domain events, with a marked fallback sample; `store` on `/me` for the connection label.
  - Endpoint limit 10 → 25 (one subscription per trigger). Zapier and Make app cards (standard). The Zapier/Make developer-console entries are the owner's to publish; README maps triggers/actions.
  - Verified with a real API key: /me, order.created samples from a real order, review fallback sample, unknown 404, subscribe/unsubscribe, app cards. Test orders and keys removed.
- [x] 194. Back-in-stock alerts: a shopper leaves an email/phone on a sold-out variant; they are told once when stock returns; the merchant sees the demand. (backend done, UI in frontend-handoff.md)
  - `stockAlerts/` + `stock_alerts` (migration 467, one waiting alert per variant and address). Accepted only for a sold-out variant without overselling; 20 an hour per IP.
  - A ProductVariant afterUpdate hook (like product.low_stock) records `variant.back_in_stock` when available stock crosses from ≤0 to >0 and someone is waiting; the consumer re-checks stock and tells each shopper once (email template `back_in_stock` or SMS with the product link), then marks them notified.
  - No marketing consent is implied: the address is used for that one message. Merchant summary per variant (waiting/notified).
  - Verified: in-stock refused, email + phone subscribe, duplicate no-op, both fields refused, summary, restock → both notified once. Variant stock restored, alerts removed.
- [x] 195. Pre-orders: a sold-out variant can be sold as a pre-order with an expected ship date and an optional limit; the order and the shopper see it. (backend done, UI in frontend-handoff.md)
  - Migration 468: `products.preorder` { enabled, shipsAt, limit, message } and `order_items.preorder_ships_at`. Per product (all its variants), limit per variant.
  - One change at the single stock gate: `inventoryService.reserve` asks `preorders.allowsPreorder` before refusing; pre-sold units = reserved − on hand, so the limit holds across orders and frees itself on cancel/restock.
  - An OrderItem afterCreate hook (in the order's transaction) marks lines saved while oversold with the ship date and tags the order `preorder`. Product payload gets `preorder`.
  - Verified: refused without pre-orders, accepted within the limit with item date + order tag, refused over the limit, merchant list with pre-sold counts, public field. Stock, reservations and test orders restored.
- [x] 196. Cookie consent: the store's consent banner settings, and pixels (browser and server events) sent only with the shopper's consent where the store asks for it. (backend done, UI in frontend-handoff.md)
  - `marketing/cookieConsent.js`: `settings.cookie_consent` { mode off|notice|opt_in, countries, policyUrl, texts } (website.edit), exposed on GET /store/:ws. No migration.
  - opt_in is enforced server-side at both ad-platform exits: the browser-event relay needs `consent.marketing === true` in the batch, and purchase events need the order's `attribution.consent` (from checkout `trackingConsent`). With a country list, visitors from other known countries are not asked (relay country via the IP lookup, orders via ipCountry).
  - Zimos' own first-party analytics are not gated. Default off keeps every store as it was.
  - Verified: invalid mode 422, settings + store exposure, relay none/accepted/rejected, order consent false/true/unanswered, country list EG vs DE, notice mode passes.
- [x] 197. Store gates: a password-protected or "coming soon" store with an email sign-up, and an optional age check. (backend done, UI in frontend-handoff.md)
  - `storeGate/`: `settings.store_gate` (website.publish) + `store_gate_signups` (migration 469). Password stored as scrypt hash; unlock token HMAC-signed with the password version (30 days; changing the password signs everyone out).
  - Enforced server-side in resolvePublicWorkspace: locked stores answer 423 STORE_LOCKED except the metadata, the gate, analytics/fonts/visitor context, existing customers' areas (orders/*, downloads, learn, subscriptions, affiliate) and funnels unless lockFunnels; staff previews pass.
  - Age check is a storefront notice (cannot be verified), not a lock.
  - Verified: password required, lock, products/cart/blog 423 with gate details, metadata/gate/visitor/order tracking open, wrong password, unlock token works, sign-ups deduped, token void after password change, coming soon, hash never returned, reopened. Settings and sign-ups removed.
- [x] 198. Purchase limits per product: minimum and maximum quantity per order (and per customer), enforced at checkout and in the cart quote. (backend done, UI in frontend-handoff.md)
  - `catalog/purchaseLimits.js` + `products.purchase_limits` (migration 470). Units counted per product across variants and offers.
  - Checkout (store and funnel, before stock is held): min, max, and maxPerCustomer (earlier non-cancelled, non-test orders by the same phone). Cart add/update: max, so shoppers hear early. Staff orders are not limited. Product payload carries the limits.
  - Errors keep the existing 422 shape with per-product `details` (productId and the limit hit, `left` for per-customer).
  - Verified: min>max refused, below min, above max, within, per-customer remainder, another customer unaffected, cart max, public limits. Orders, stock and test cart restored.
- [x] 199. Estimated delivery dates: min/max days per governorate/place and shipping option, shown on the product page, cart and checkout, and stored on the order. (backend done, UI in frontend-handoff.md)
  - `shipping/deliveryEstimates.js`: `settings.delivery_estimates` (shipping.manage) — default, per governorate code, per store place (area → city → region), cutoff hour, skipped weekdays; working days in the store's time zone. No migration.
  - Public estimate endpoint, `deliveryEstimate` on the shipping quote, kept on the order's shipping snapshot at checkout and shown on tracking. Per shipping option is left out (options carry no days yet); noted for later.
  - Verified: min>max refused, Cairo region (ar/en) vs default, after-cutoff start with Friday skipped (Thu 8 → Sat 10), quote, order snapshot, off. Order and settings removed.
- [x] 200. ~~Email campaigns~~ — WITHDRAWN: SPEC §21 forbids campaigns of any kind, email blasts included (owner, 2026-10-03), and LANES says §21 still holds and "bulk sends to a whole segment stay out". This item should never have been queued. It was built in 418801d and reverted. Migration 472 is left unused (its tables were dropped from the dev database). Do not rebuild it unless the owner records a decision in SPEC §21.
  - Kept from that commit: the store gate leaves /store/:ws/marketing/unsubscribe open, so the abandoned-cart email's unsubscribe link also works on a locked store.
  - Frontend requests answered in the same pass (7f9c213): X-Shopper-Token and X-Store-Gate allowed by store CORS; Shopify/WooCommerce apps available (opening the dropship page); import report productIds/results/sourceCurrency/reviewsImported (migration 471); separate LINK_* error codes.
- [x] 201. Gift cards with online payments: the gateway attempt charges the total minus the card (follow-up of 189). (backend done, UI in frontend-handoff.md)
  - giftCards/giftCardHolds.js: the card's part is held at checkout (off the card's balance at once, a `hold` ledger line), not paid: the order's money only moves when it is really paid. startAttempt charges total − paid − held (retries too).
  - recordPaymentTransaction captures the holds into `gift_card` payments in the same transaction, before amountPaid and the financial state are set, so the order is `paid` by both. A payment on an order that stays cancelled or blocked releases them instead.
  - Released on expiry (expireOrder) and on order.cancelled (refundCancelledOrder); idempotent. Switch to COD captures them (up to the repriced total, the rest given back) and sets partially_paid/paid.
  - Card covering the whole order: the order is switched to COD at once through switchToCod (its COD checks apply) and paid by the card; if COD is refused, the hold is undone and the gateway charges everything.
  - Shopper status: a COD order partly paid (card or deposit) now reads `cod`, not `paid`; new giftCardHeld/amountDue.
  - Paid after expiry and reopened: the hold was given back at expiry, so the order is partly paid and the merchant sees it (not retaken from the card).
  - Verified with the sandbox gateway: part card + gateway paid, expiry release, switch to COD, full-cover, bank transfer refused; data cleaned.
- [x] 202. Scheduled reports: a daily or weekly summary email (sales, orders, confirmation and delivery rates, top products) to chosen team members. (backend done, UI in frontend-handoff.md)
  - modules/scheduledReports + migration 473 (report_deliveries: one row per store, kind and period, claimed before sending, so a report goes out once even with several workers).
  - Numbers come from analytics/overviewService.getOverview, so they match the dashboard home. Periods are store-local: daily = yesterday, weekly = the 7 days before the chosen weekday; both are compared with the period before.
  - A schedule runs every 15 minutes and sends once the store-local hour has passed. A report missed during downtime still goes out later that day; earlier days are not backfilled.
  - Recipients: active members whose role has analytics.view (or *), checked again at send time. Language = the member's locale, else the store's. Settings permission: workspace.manage; preview and send-to-me: analytics.view.

## Sixth pass (2026-10-06) — gap pass after the fifth list

How the list was made: the code was searched for features merchants expect from Lightfunnels and the stores they
compare it with, and that are not in the code: loyalty, store credit, price lists, stock locations, purchasing, gifts
with purchase, notes on customers, size charts and search analytics. Every item was checked against SPEC §21:
**no campaigns or bulk sends of any kind** (item 200 was withdrawn for this), no fake urgency or social proof, no call
centre, no unofficial WhatsApp. Outside services are an interface + `sandbox` adapter + README; migrations stay in
474–499; no prices in code.

- [x] 203. Loyalty points: the merchant sets the earn rate (points per currency unit on delivered orders) and the value of a point; points are redeemed at checkout as a discount, can expire, are shown in the shopper account, and are taken back when an order is returned or refunded. (backend done, UI in frontend-handoff.md)
  - modules/loyalty + migration 474 (customers.loyalty_points / loyalty_activity_at, loyalty_transactions; an order earns once, by a unique partial index).
  - Spending points is a captured `loyalty` payment (like a gift card), not a discount: the order total and its tax and discount logic stay as they are, refunds give the points back (Refund hook), and the hold/capture/release for online orders is shared with gift cards through payments/heldTenders.js. That layer replaced the gift-card-only calls in onlinePaymentService.
  - Earn on order.delivered, on what was paid for goods (total − shipping − refunded − paid by points), rounded down; taken back on order.returned and order.cancelled (clamped at 0). Partial refunds after delivery don't reduce earned points.
  - Spending needs a signed-in shopper (X-Shopper-Token) — a phone number proves nothing. Only orders in the store currency earn or spend.
  - Expiry: the whole balance expires after expiryDays without earning or spending (daily job), not per-earn FIFO.
  - Merchant refunds may now name a gift_card/loyalty paymentId (paymentService STORE_TENDERS); before, only gateway payments could be named on a mixed order.
  - Verified: settings validation, COD spend + 50% cap, auth/min/balance errors, cancel returns points, earn once + reverse on return, online hold → gateway paid → captured, merchant refund 2000 → 200 points, expiry, staff history; gift-card test (201) re-run unchanged.
- [x] 204. Store credit: staff give a customer credit (or refund an order to store credit), the shopper spends it at checkout (COD and online, like gift cards), and the balance and its history are shown to staff and in the shopper account. (backend done, UI in frontend-handoff.md)
  - modules/storeCredit + migration 475 (customers.store_credit_amount, store_credit_transactions). Store currency only.
  - Spending is a captured `store_credit` payment, held for online orders through payments/heldTenders.js (order: gift card, store credit, points). Refunds of it and cancelled orders put it back (Refund hook + order.cancelled consumer).
  - Refund to store credit: a processed Refund with no payment, counted in amountRefunded, with a credit note. Eligible = paid − refunded (credit is never given for money not received). The financial state follows the existing rule (refunded only when the whole total is refunded).
  - Spending needs a signed-in shopper; settings.store_credit.enabled (default on) only controls spending. Giving and taking credit needs refunds.manage.
  - Verified: empty/no-token errors, over-take refused, grant, COD spend, refund of the credit payment, refund to credit (and its cap), online hold, cancel returns the hold, account and holders views; loyalty online test re-run.
- [x] 205. Wholesale price lists: price lists by customer tag (a percentage off, or fixed variant prices, with minimum quantities), applied to signed-in shoppers in the cart and at checkout, and shown on product pages. (backend done, UI in frontend-handoff.md)
  - modules/priceLists + migration 476 (price_lists, price_list_prices). A list matches a contact's tags; only signed-in shoppers get it (a typed phone proves nothing).
  - The checkout pins the list price on plain lines with the same server-side marker as product A/B test prices (productTests), so orderService prices the order. Lowest wins (normal or test price vs every matching list); trials still set 0 after. Offer bundles and funnel checkouts are not changed.
  - The cart passes X-Shopper-Token to getCart, which reads the list prices like test prices. Add/update/remove re-read the cart with them.
  - Product page endpoint returns only the tiers that are cheaper than the normal price. Staff lists are replaced whole on PUT.
  - Verified: validation, fixed tiers by quantity (1 → 20000, 5 → 18000), percent 30% for a second tag (lowest wins), anonymous unaffected in page, cart and orders.
- [x] 206. Multiple stock locations: stock per location (warehouse, shop), orders assigned to a location that has the stock, transfers between locations, and the location on the packing slip (the plan feature `multi_warehouse`). (backend done, UI in frontend-handoff.md)
  - modules/stockLocations + migration 477 (stock_locations, location_stock, stock_transfers, orders.stock_location_id).
  - The variant total (stock_on_hand) stays the one sellable number, so no existing stock path changes. Only non-default locations store a count; the default holds the remainder. Counts always add up, including stock set by imports, bulk edits and returns, which land at the default.
  - Reserved per location comes from the reservation movements of the orders assigned there. Unassigned orders, and reservations that can't be traced to an order (orders from before reservations named their order), count at the default. Changing the default re-splits on-hand counts and names the old default on its orders, but those untraceable reservations move with the default.
  - Orders are assigned on order.created to the first active location by priority that has every line free (the order's own units count as free at the default); otherwise the default. Staff can reassign. Stock never leaves on shipping in this codebase (sold units stay reserved), so a location's reserved count grows the same way the store's does.
  - A second location needs plan feature multi_warehouse. Adjustments write a stock movement (reference stock_location); transfers don't change the total.
  - Verified: plan gate, adjust (+10 → total 60), transfer and its limit, below-zero refusal, auto-assignment by priority, reassignment, default switch, delete refused with stock, per-location stock list; data restored.
- [x] 207. Suppliers, purchase orders and stock counts: a supplier list, purchase orders with lines and unit costs, receiving into stock (updating cost), and stock counts that adjust stock with a reason. (backend done, UI in frontend-handoff.md)
  - modules/purchasing + migration 478 (suppliers, purchase_orders, purchase_order_lines, stock_counts, stock_count_lines). Permissions inventory.view / inventory.manage.
  - Receiving writes a restock movement (reference purchase_order) at the order's stock location (non-default locations get their count raised, item 206) and sets variant cost to the weighted average of on-hand and received units. With no previous cost or no stock, the unit cost is used; updateCost:false keeps it.
  - PO numbers are PO-0001… per store (next = max + 1, unique index). Only drafts are editable; cancel only before anything is received; a supplier with orders can't be deleted.
  - Stock counts apply counted − on hand at apply time (not the expected snapshot), so sales during the count are not undone. Each change is an adjustment movement (reference stock_count).
  - Verified: supplier, PO create/order/edit refusal/partial and full receive, over-receive refusal, cost 8000 from none, updateCost false, cancel refusal, supplier in use, count create/enter/apply (−2), double apply refused; stock and cost restored.
- [x] 208. Free gift with purchase: rules (minimum subtotal or a product in the cart) that add a chosen gift line at no charge in the cart and at checkout, limited by stock, with the gift removed when the rule stops holding. (backend done, UI in frontend-handoff.md)
  - modules/freeGifts; rules in settings.free_gifts (no migration). The checkout appends gift lines with the server-pinned price marker at 0 (the A/B-test price mechanism), after purchase limits, so a gift never trips a limit and the shopper can't add or keep one.
  - Qualification uses the lines' prices before bundle tiers and the order discount (plain lines: pinned or effective price; offer lines: offer price). The cart uses its line totals (after bundles) for the "add X more" hint. The two can differ slightly when bundle tiers apply.
  - A gift is added only while its variant is in stock (or oversells), one line per gift variant. Funnels are left alone. Gifts reserve stock like any line.
  - Verified: rule validation, product rule (gift at 0, total unchanged), subtotal rule below/above, gift out of stock skipped, cart hints (missing amount, out of stock).
- [x] 209. Notes and follow-ups on customers: staff notes on a contact (with author and time), follow-up reminders assigned to a team member, and a due-reminders list and notification. (backend done, UI in frontend-handoff.md)
  - modules/customerNotes + migration 479 (customer_notes, customer_followups). Writing notes and follow-ups needs only customers.view (support staff take notes); deleting a follow-up needs customers.manage, and only the author or a manager edits a note.
  - Reminders: a 5-minute schedule claims each due follow-up (notified_at) and sends the new merchant notification type customer.followup to the assignee (or the whole team when unassigned). Moving the time or the assignee re-arms it.
  - Verified: notes (author, edit, pin order, delete), assignee check, overdue flag, my list and overdue count, notification sent once over two runs, done.
- [x] 210. Size charts: reusable size tables (rows/columns, cm/inch), attached to products or collections, shown on the product page. (backend done, UI in frontend-handoff.md)
  - modules/sizeCharts + migration 480 (size_charts with product_ids / collection_ids arrays). Cells are text, so "S", "38–40" and "96" all fit; the unit says what the numbers are in, and the storefront converts for the shopper.
  - Resolution: a chart on the product beats one on its collections; among several, the newest. Public endpoint cached 5 minutes.
  - Verified: row/column check, none, by collection, own wins, update, delete falls back to the collection's.
- [x] 211. Storefront search analytics: what shoppers search, searches with no results, the results clicked, and merchant-set synonyms used by the store search. (backend done, UI in frontend-handoff.md)
  - modules/searchInsights + migration 481 (search_queries, one row per first-page search, click columns on the same row). Logged in the listing controller after the storefront cache, so cached answers still count. Visitor id only, no personal data; kept 180 days (daily prune).
  - Synonyms are a fallback, not query expansion: they are tried only when the words themselves find nothing, so existing results never change. The served term is reported (servedAs) and kept on the log. Saving synonyms clears the store cache.
  - Clicks: the first per search, within an hour, only for a product of that store.
  - Verified: search id on page 1 only (also on cache hits), zero results, synonym fallback, duplicate-term refusal, click counted once, report totals/top/no-results/clicked.

## Seventh pass (2026-10-06) — gap pass after the sixth list

How the list was made: the code was searched for further features merchants expect (Lightfunnels and the stores they
compare it with) that are not there. Each was checked against SPEC §21: no campaigns or bulk sends, no fake urgency or
social proof, no fake reviews, no call centre, no unofficial WhatsApp. A store minimum order amount already exists
(discounts/couponExtras.js) and is not listed. Migrations 482–499; no prices in code (every amount is the merchant's).

- [x] 212. Product questions and answers: shoppers ask on the product page, the merchant answers, answered questions are published (moderated), and the team is told about new questions. (backend done, UI in frontend-handoff.md)
  - modules/productQuestions + migration 482. Pre-moderated: nothing a shopper writes is public until the store answers and publishes it, so no spam or made-up content is shown. Asker email private; 5 questions per IP per hour.
  - New merchant notification product.question (products.manage). The answer email goes once to the asker — a reply to their own question, not marketing (§21 holds).
  - Verified: ask (+ validation), hidden before answer, publish without answer refused, answer publishes + one email, hide, public list without emails, notifications.
- [x] 213. License keys for digital products: a product sells codes from a pool the merchant uploads; a paid order gets its codes (email and order page); stock = codes left; low-pool alert. (backend done, UI in frontend-handoff.md)
  - Mostly already built under SPEC §18.2 (digital/digitalService: the pool, drawing on payment, late filling, codes in the delivery email and download page). The gap pass missed it because it searched for "license_key"; noted so the next pass searches by feature, not by one spelling.
  - Added: digital/codePoolAlerts.js. After a paid order draws codes (afterCommit of the payment), stock.low notifications go out once a day per product, for "orders waiting for codes" or "pool at or below settings.license_codes_low_at" (default 5). Plus GET/PUT /digital/code-alerts.
  - Verified: duplicates skipped, codes drawn (2), low alert, waiting alert with 2 missing, late fill on adding codes.
- [x] 214. Gift wrap and gift message at checkout: an optional wrap with the merchant's price and a message from the shopper, on the order and the packing slip, with the prices hidden on a gift slip. (backend done, UI in frontend-handoff.md)
  - modules/giftOptions + migration 483 (orders.gift_options). The wrap is a merchant-priced product added as a line (no prices in code; tax, stock and reports work unchanged). Message and hidePrices are kept on the order and printed on the waybill (plain text, PDF-safe).
  - Settings in settings.gift_options; the storefront reads store.giftOptions (cached with the store). Works for COD and online checkouts.
  - Verified: off refused, settings, store view with wrap price, message length, wrap line (+2000) and options saved, waybill lines, message-only gift.
- [x] 215. Mix-and-match box: "any 3 from this collection for a set price" built by the shopper, priced by the server at checkout. (backend done, UI in frontend-handoff.md)
  - Extends quantity bundles instead of a new engine (migration 484, bundles.mix_and_match). applyBundleTiers groups the lines of a mix-and-match bundle's products into one unit set, so the cart, shipping quote and order all price the box the same way, with every tier type and free shipping. The default (false) keeps the per-product behaviour.
  - Public box builder endpoint lists the bundle's active products with variants and availability. The pieces are ordinary cart lines.
  - Verified: 1 shirt (250) + 2 caps (100) with "3 for 400" → cart discount 50 and order total 400; with the flag off, 450 (per product, unchanged).
- [x] 216. Holiday mode: the store keeps showing but stops taking orders between dates (or takes them with a "ships after" notice), with a message. (backend done, UI in frontend-handoff.md)
  - modules/holidayMode; settings.holiday_mode (no migration). Pause = 423 STORE_ON_HOLIDAY from the checkout only (store and funnel checkouts share it); browsing, carts and tracking keep working. Delay = the order is tagged holiday with shippingSnapshot.holiday { shipsFrom, message }. Dashboard orders are never blocked.
  - The window is checked live (from/until), so a scheduled holiday starts and ends on time without a job. Saving clears the store cache.
  - Verified: date validation, pause → 423 with details, store.holiday, delay → tag + snapshot, future holiday not active yet.
- [x] 217. Sign in with Google for shopper accounts: an interface + sandbox adapter + README, linked to the shopper account by email. (backend done, UI in frontend-handoff.md)
  - shopperAccounts/google/ (google.js verifies the GIS ID token with google-auth-library, sandbox.js for SHOPPER_GOOGLE_MODE=sandbox outside production, README). Settings in settings.shopper_google, separate from shopper_accounts, whose PUT replaces it whole.
  - Only a Google-verified email is used, matched case-insensitively to the store's existing contact. No contact is created, because customers need a phone; documented in the README and the error text.
  - The store's own client id is needed for custom domains (Google checks the origin); otherwise the platform's GOOGLE_CLIENT_ID is used. The id is public; no secret in this flow.
  - Verified (sandbox): off, bad client id, config, no account, invalid token, sign-in with case-different email, token works on /account/me.
- [x] 218. VIP tiers: customers move up automatically by what they spent (tiers the merchant defines), with perks applied at checkout (a percent off, free shipping, a points multiplier) for signed-in shoppers. (backend done, UI in frontend-handoff.md)
  - modules/vipTiers; settings.vip_tiers (no migration). The tier is computed live from delivered orders (orderStage STAGE_SQL), net of refunds, optionally windowed, so returns and cancellations lower it by themselves. Perks only for signed-in shoppers.
  - % off uses the server-pinned price marker (lowest of normal, price list and VIP; 0-priced gifts and trials untouched). Free shipping is a server-set symbol on the checkout payload that orderService turns into "every line ships free" (the existing all-free rule). Points multiplier read by loyalty earnForOrder.
  - Verified: validation, tier only after delivery, next-tier distance, VIP price 22500 vs 25000, free shipping (0 vs 3000 with a temporary extra fee), points ×2 (450), staff view; data and product restored.
- [x] 219. Quote requests (B2B): a shopper asks for a quote for quantities; staff answer with prices and a validity date; the shopper accepts and it becomes an order (payment link reused). (backend done, UI in frontend-handoff.md)
  - modules/quotes + migration 485 (quote_requests, Q-0001 numbering). The shopper holds a private token (hash stored). Staff quote only requested products; accepting creates a COD order through orderService.createOrder with the quoted unit prices pinned server-side, so stock, shipping, fraud rules and the blocklist all apply. The order is tagged quote, and online payment goes through the existing payment link.
  - Expiry is checked on read and on accept (no job). New merchant notification quote.request. The shopper hears once when the quote is ready (merchant_notification template, bilingual title).
  - Verified: request, wrong token, accept before quote, foreign line refused, answer, shopper view (quoted vs list price), accept → order 5 × 20000 tagged quote, double accept refused, expired refused; stock limit enforced (30 > 11 free refused).

## Eighth pass (2026-10-06) — gap pass after the seventh list

How the list was made: each candidate was searched under several spellings (after item 213 was found already built under
another name). Not listed because already built: review photos (reviews/shopperReviews), store minimum order, branch
pickup as a fixed shipping option, confirmation-task assignment. Not listed because of SPEC §21: browse-abandonment
messages (a marketing send) and order assignment to agents (call-centre territory). Migrations 486–499; no prices in
code.

- [x] 220. Shopper self-service on orders: cancel an order, or change its delivery address, from the account or tracking page, before it is confirmed or shipped, within a window the merchant sets. (backend done, UI in frontend-handoff.md)
  - shopperAccounts/orderSelfService.js; settings.order_self_service (no migration). Ownership by shopper token (order's customer) or the signed tracking token. Cancel reuses orderService.cancelOrder with a shopper request (user id null). confirmationService.closeTasksForCancelledOrder now skips the agent attempt row when no staff member acted.
  - Cancel refused once confirmed, shipped, cancelled, or paid online (a refund is the merchant's decision). Address change allowed until shipped; deliverability checked like checkout, shipping not repriced. Both notify the team and are audited.
  - Verified: off by default, wrong token 404, window shown, address changed, cancel releases the reserved unit, double cancel refused, confirmed order → address only.
- [x] 221. Delivery date and time slots at checkout: merchant-defined slots per weekday, capacity per slot, a cutoff, and closed days; the chosen slot on the order and the waybill. (backend done, UI in frontend-handoff.md)
  - deliverySlots/index.js; settings.delivery_slots; migration 486 delivery_slot_bookings. Dates and times are the store's timezone. Capacity counts bookings of orders not cancelled; a cancelled order frees its place.
  - Checkout holds a place before creating the order (advisory lock per store, recount inside it) and gives it to the order afterwards; a hold whose order never got created stops counting after 10 minutes. Funnels included.
  - The slot is kept on shippingSnapshot.deliverySlot and printed first among the waybill's customer details. The team can move an order (force past capacity) and see a schedule per day/slot. Public view exposes only available true/false, not counts.
  - Verified: off = 404, bad slot 422, closed day skipped, required enforced, capacity 1 full on 2nd order, waybill line, schedule, move with/without force, cancellation frees the slot.
- [x] 222. Customer referral program: a shopper's referral link; the friend gets the merchant's welcome reward on a first order, the referrer gets store credit or points once that order is delivered; no self-referral (same phone/email). (backend done, UI in frontend-handoff.md)
  - customerReferrals/{index.js, jobs.js}; settings.customer_referrals; migration 487 (customer_referral_codes, customer_referrals). Separate from referrals/ (ZIMOS's own merchant program) and affiliates/ (cash commissions).
  - The friend's reward is a percent off plain lines (server-pinned price marker, lowest price wins) and/or free shipping — no new discount type. First order = no earlier non-cancelled order on that phone. Self-referral refused by account, normalized phone or email.
  - Referrer rewarded on order.delivered (store credit ledger kind 'referral', or loyalty points kind 'referral'), once; cancel/return before that voids the invite; a minimum order total and a per-referrer cap are optional. The inviter never sees friends' names.
  - Verified: off/on, code stable and case-insensitive, self by phone and email refused, bad code, 10% applied, second order refused, reward once (double event), void on cancel, staff list, cleanup.
- [x] 223. Frequently bought together: product pairs computed from real orders (nightly), served on the product page and the cart, with merchant pins and exclusions. (backend done, UI in frontend-handoff.md)
  - Mostly there already: offers/offerRules.js suggestCrossSell (merchant cross-sell rules = pins, else a live order query) at cart/checkout/thank-you. Added: boughtTogether/{index.js, jobs.js}; migration 488 product_affinities (top 20 per product, nightly + on save); settings.bought_together (window, minOrders default 1 as before, excludedProductIds); placement 'product' for the product page; test orders now left out.
  - offerRules.boughtTogether delegates to boughtTogether.suggest; a store not computed yet reads live (same SQL plus the exclusions).
  - Verified: live list, minOrders 2 drops the single pair, exclusion, product view counts, pin rule wins, bad exclusion 422, off, computeAll.
- [x] 224. Stock forecast: sales speed per variant, days of stock left, a suggested reorder quantity, and "make a purchase order" from the suggestions (item 207). (backend done, UI in frontend-handoff.md)
  - stockForecast/index.js; settings.stock_forecast; no migration (computed on request, one SQL over order_items and open PO lines). available = on hand − reserved (sold units stay reserved). incoming = ordered/partially received PO lines not yet received.
  - suggested = ceil(perDay × (lead time + cover + safety)) − available − incoming. Status: out, reorder_now (days left ≤ lead time + safety), soon (+7 days), ok, no_sales. Whole store, not per location.
  - Draft PO through purchasing.savePo (now exported); quantity defaults to the suggestion, unit cost to the variant cost.
  - Verified: 6 sold in 30 days → 0.2/day, 30 days left, suggestion 3 → 9 after a settings change, PO created, incoming counted (suggestion 0), nothing-to-order and foreign-variant refusals, cleanup.
- [x] 225. Click and collect: pickup at a stock location (item 206) as a shipping option, with no delivery address, a "ready for pickup" step, and a pickup code checked when the customer collects. (backend done, UI in frontend-handoff.md)
  - clickAndCollect/{index.js, jobs.js}; settings.click_and_collect; migration 489 order_pickups (location snapshot, 6-digit code, pending → ready → collected | cancelled). Email template pickup_ready.
  - Checkout `pickupLocationId`: drops the address and shipping option, sets the free-shipping marker, skips the form's address fields and the postal-code rule; every line must be free at that location (stockLocations.stockMatrix). The order is assigned to the location (stock_location_id), tagged `pickup`.
  - Collect checks the code (constant time), sets fulfillment fulfilled through orderStateService and records order.delivered, so the stage is delivered and delivery hooks run. order.cancelled cancels the pickup. Waybill line.
  - Verified: off 404, settings validation, availability per place, out of stock at the second place, pickup order with 0 shipping and no address, shopper view by tracking token, ready + email, wrong code, collect → stage delivered, cancel, normal delivery checkout unchanged, cleanup.

## Ninth pass (2026-10-07) — gap pass after the eighth list

How the list was made: each candidate searched under several spellings first. Not listed because already built:
back-in-stock alerts (stockAlerts), pre-orders (preorders), customer segments with rules (contacts/segmentRules —
covers auto-grouping), order line editing (orders/orderItemsEdit), quantity breaks, option prices
(catalog/customFieldPricing), invoices. Not listed because of SPEC §21: anything sending to many customers at once.
Migrations 490–499; no prices in code.

- [x] 226. Pick list: for the orders picked in the list (or every order ready to ship), the units to take off the shelves, summed per variant, grouped by stock location, with SKU and image, and which orders each serves; JSON and a printable PDF. (backend done, UI in frontend-handoff.md)
  - orders/pickList.js, POST /orders/documents/pick-list (beside waybills, invoices and manifest); no migration. Grouped by the order's stock location (default when unassigned), summed per variant (or per name+options for lines without a variant), with the orders each line serves.
  - JSON, PDF (Arabic through bidiText) or base64. readyToShip uses the shared STAGE_SQL so it matches the orders list tab.
  - Verified: 3 orders → 3 + 3 units with per-order split, ready-to-ship selection after confirming 2, PDF rendered and checked as an image, both/none 422.
- [x] 227. Scheduled price changes: a sale on chosen variants, products or a collection — a new price (fixed or percent off) from a start time, and the old price back at an end time, applied by the server; listed, editable before it starts, cancellable. (backend done, UI in frontend-handoff.md)
  - priceSchedules/{index.js, jobs.js}; migration 490 (price_schedules, price_schedule_items). The sale writes the variants' real price (and the pre-sale price as compare-at when showWasPrice) so every price reader agrees; no new pricing path.
  - Variants resolved at the start (collection members then). A variant in another running sale is skipped. At the end a price goes back only if it is still the sale price; otherwise the team's price is kept and the sale's "was" price removed. A sale whose whole window passed while the job was down never starts.
  - Minute job price_schedules.tick; a start time already past starts on create.
  - Verified: preview, window/target validation, 20% applied with was-price, overlap skipped, edit refused while running, stop → restored / kept (was-price cleared), future sale started and ended by the job, cancel, T-shirt untouched.
- [x] 228. Business customers: company name and tax ID on a customer, a tax-exempt flag honoured at checkout for that signed-in customer, and the tax ID printed on the order invoice. (backend done, UI in frontend-handoff.md)
  - businessCustomers/index.js; migration 491 (customers.company_name, tax_id, tax_exempt, tax_exempt_note). orderService: exemptFor() zeroes the added tax, withBusiness() puts company/taxId/taxExempt in the contact snapshot; invoice prints them (tax ID on its own LTR line).
  - Exemption only for the signed-in customer (a symbol carrying their id, checked against the order's customer) or staff orders; never a guest by phone. Shoppers edit company/tax ID; changing the tax ID drops the exemption.
  - Verified: 14% rate taxed 3500, exempt signed-in order 0 tax with snapshot, guest same phone taxed, invoice rendered and checked as an image, tax ID change drops exemption.
- [x] 229. Pay later on account (net terms) for approved business customers: a credit limit and N days to pay, an "on account" checkout method for those signed-in customers, the outstanding balance, overdue orders, and the merchant recording the payment. (backend done, UI in frontend-handoff.md)
  - accountCredit/index.js; migration 492: payment method enum value on_account, customers.on_account_enabled / credit_limit / payment_terms_days, orders.payment_due_at. methodNames lists it; orderStage treats it like COD (not awaiting payment); carrier booking allowed unpaid; codAmountFor already 0 (not cod); waybill says ON ACCOUNT — DO NOT COLLECT.
  - orderService.checkOrder runs before the order row inside the transaction, with the customer row locked: approved + signed-in shopper symbol matching the order's customer (or staff), and owed + total ≤ limit, else nothing is created. Due date = now + terms.
  - Payments recorded as captured `manual` payments (method on_account), so refunds follow the manual path. Owed/overdue computed from orders, no ledger table.
  - Verified: guest 401, unapproved 422, approved order with due date, over-limit refused with available, stage ready_to_ship, waybill not COD, statement, overdue list, partial + full payment → paid, wrong-order refusal.
- [x] 230. Stock lots with expiry dates: receive units with a lot and an expiry date, see what expires soon, write expired units off, and the pick list naming the lot to take first (first expiring, first out). (backend done, UI in frontend-handoff.md)
  - stockLots/{index.js, jobs.js}; migration 493 (stock_lots, stock_lot_allocations). Lots sit beside the variant count (still what the store sells from): receive (optionally adding stock through purchasing.moveStock, now exported), label existing stock (capped at on hand), write off (adjustment movement).
  - Consumption FEFO on order.shipped / order.delivered, once per order (allocations). Daily stock_lots.alert_expiring → merchant notification type stock.lot_expiring, once per lot (alerted_at reset when the date changes).
  - Pick list lines carry FEFO lot suggestions (JSON and PDF).
  - Verified: 2 lots → stock 10, over-label refused, pick list A 5 + B 2, consumption idempotent (A 0, B 3), expired/expiring filters, one notification, write-off 12 → 10, empty lot refused, PDF checked as an image.
- [x] 231. Product specifications and comparison: key/value specifications per product (merchant-defined keys), shown on the product page, usable as storefront filters, and a public compare of up to 4 products side by side. (backend done, UI in frontend-handoff.md)
  - productSpecs/index.js; migration 494 (spec_keys, product_specs). Keys per store (≤ 100, ar/en name, unit, filterable, order); one text value per product and key, replaced whole.
  - Storefront specs and filters read through storefrontCache; filtered list is its own endpoint (keys AND, values OR, optional collection, hidden products left out) rather than a change to the main listing query; compare 2–4 with a differs flag per key.
  - Verified: key validation, values per product, suggestions, store specs, filter counts, AND/OR filtering, bad filter 422, compare + differs, 1 product 422, key delete cascades.

## Tenth pass (2026-10-07) — gap pass after the ninth list

How the list was made: candidates searched under several spellings first. Not listed because already built:
customer CSV import (contacts/contactImport), weight-based shipping, gift card balance, one-click upsells, UTM /
channel reports, 2FA, age notice (storeGate ageCheck), dynamic segments. Not listed because of SPEC §21: survey or
review requests sent to many customers at once. Migrations 495–499 are the last of this pass's range.

- [x] 232. URL redirects: the merchant's old-path → new-path list (301/302), a public lookup the storefront calls on a not-found page, and a redirect added by itself when a product or collection slug changes; CSV import for a platform move. (backend done, UI in frontend-handoff.md)
  - urlRedirects/index.js; migration 495 url_redirects (unique per store and from path; hits). Paths normalised (decoded, trailing slash dropped, query kept); lookup tries path+query, then path. Targets: a store path or an https URL only.
  - Product/Collection afterUpdate hooks (installed when the module loads) add the slug redirect, re-point older redirects (no chains) and drop a redirect away from the new address. Loop check follows up to 10 hops.
  - Verified: create/lookup (trailing slash, query), duplicate, self, loop, https target, http refused, CSV import with a bad line, slug change and change back, legacy redirect re-pointed, hits.
- [x] 233. Store locator: the store's branches (from stock locations) with address, phone, opening hours, map coordinates and a "get directions" link, as a public list and a nearest-branch answer for given coordinates. (backend done, UI in frontend-handoff.md)
  - storeLocator/index.js; settings.store_locator keyed by stock location (no migration): visible, phone, WhatsApp, hours, note, coordinates. Public list nearest-first by haversine distance; directions link from coordinates or address; pickup flag from click and collect.
  - Verified: off 404, lat without lng refused, hidden location left out, distances from Alexandria (3.2 km vs 178.7 km), nearest.
- [x] 234. Price history: every variant price change recorded, the lowest price of the last 30 days shown honestly next to a sale price, and the history in the dashboard. (backend done, UI in frontend-handoff.md)
  - priceHistory/index.js; migration 496 variant_price_history, seeded with today's prices. ProductVariant afterCreate/afterUpdate hooks record a row when price or compare-at really changes (inside the caller's transaction).
  - Lowest in 30 days = min(today, every price set in the window, the price in force when the window opened). Public batch endpoint for sale badges; dashboard history per variant.
  - Verified: create/patch/no-op patch/sale rows, lowest 9000, older 8000 in force at window start → 8000, superseded by 11000 before the window → 9000, bad ids 422.
- [x] 235. Customer privacy requests: a signed-in shopper downloads their data or asks to delete their account; the team sees the requests and completes an erase that removes personal details but keeps order and accounting records. (backend done, UI in frontend-handoff.md)
  - privacyRequests/index.js; migration 497 privacy_requests (kind export|erase, status, a short requester label that survives the erase). Export is immediate for the signed-in shopper (logged); erase is a request the team completes or declines, or the team erases directly.
  - Erase anonymises in one transaction: customer PII cleared (phone_normalized replaced by a unique placeholder), account_version bumped (tokens die), orders keep amounts/lines and country/province/city only, addresses/login codes/saved cards/wishlist deleted, review author names nulled. Refused while an order is still in progress (stage not delivered/cancelled/returned) unless forced. Audited.
  - Verified: export content, pending request, duplicate returns it, refusal on an open order, completion → anonymised customer and order, old token 401, staff export and forced erase, request log.
- [x] 236. Post-purchase survey: one or two questions on the thank-you page ("How did you hear about us?", a 0–10 score), answers kept on the order, and a report. (backend done, UI in frontend-handoff.md)
  - postPurchaseSurvey/index.js; settings.post_purchase_survey (≤ 3 questions: choice with optional other, score 0–10, text); migration 498 survey_responses (one per order, upsert for 7 days). Nothing is sent: answered on the thank-you page only.
  - Checkout responses now include trackingToken (orderTrackingExtras.tokenFor) so the thank-you page can prove the order; ownership also by shopper token or payment token. Report: counts, other texts, average, NPS, distribution, latest texts.
  - Verified: off 404, option validation, required, bad option/score, answer + change, own read, report (2 TikTok, 1 other, avg 6.7, NPS 0), staff order view, closed after 7 days.
- [x] 237. RFM customer scores: recency, frequency and money scores 1–5 per customer from delivered orders, the usual labels (champions, loyal, at risk, lost…), counts per label, and a filter in the customer list. (backend done, UI in frontend-handoff.md)
  - rfm/index.js; no migration: one SQL (shared STAGE_SQL, delivered orders only, refunds off, test/cancelled out) with NTILE(5) per dimension and a fixed label table. Summary per label, filtered/sorted customer list, one customer.
  - Verified with 8 customers of different patterns: champions, cant_lose, at_risk, new, lost ×2, need_attention ×2; label filter; bad label 422.

## Eleventh pass (2026-10-07) — reports gap pass

How the list was made: the analytics reports (sales, products, delivery, customers with monthly cohorts, insights),
profit, stock forecast and RFM were read first. The gaps are reports a merchant needs for accounts and stock
decisions. All of them read existing tables: no migration (only 499 is left of this pass's range; a new range is the
owner's call and is noted in LANES when given).

- [x] 238. Tax report: tax collected per month and per rate/governorate for delivered and paid orders, refunds taken off, tax-exempt orders counted apart, with CSV. (backend done, UI in frontend-handoff.md)
  - storeReports/index.js (new home for items 238–242, mounted at /store-reports, JSON or CSV). Orders delivered or paid, by month (store tz) × governorate; refunds take their share of tax; exempt orders apart; fx-converted. Per-rate split is not possible (orders keep one tax amount), so the place stands in for it.
  - Verified: delivered taxed order with half refunded (3500 → net 1750), exempt order apart, pending order left out, CSV.
- [x] 239. Inventory valuation: on-hand units × unit cost per variant and per stock location, the total, and the variants without a cost; CSV. (backend done, UI in frontend-handoff.md)
  - storeReports /inventory-value. On hand × cost (on hand is still on the shelf: a sale leaves it when committed); reserved and free shown; per location through stockLocations.stockMatrix; variants without cost listed apart and out of the totals.
  - Verified: 10 units at 40 = 400 (free 320), no-cost variants listed, transfer 4 to a second location → 240/160 split, location filter, CSV.
- [x] 240. Slow-moving and dead stock: variants with stock but no sale in 30/60/90 days, units and value tied up, last sale date; CSV. (backend done, UI in frontend-handoff.md)
  - storeReports /slow-stock. Free units (on hand − reserved) with no live order line in the window; value at cost; never-sold flagged; variants younger than the window skipped unless includeNew. Window limited to 30/60/90/180.
  - Verified: never-sold and sold-75-days-ago show at 60 days, only never-sold at 90, recently sold left out, bad window 422, CSV with ISO dates.
- [x] 241. Discount code performance: per code — uses, orders, revenue, discount given, average order, new vs returning customers, and cancellations; for a date range. (backend done, UI in frontend-handoff.md)
  - storeReports /discounts from discount_redemptions × orders (stage via the shared STAGE_SQL in a subquery). Live-order revenue and discount given, delivered revenue net of refunds, cancellations, new vs returning by the customer's earlier non-cancelled orders.
  - Verified: 3 orders with ZZTEN (one cancelled, one delivered, one by a returning customer) → orders 3, cancelled 1, revenue 450, delivered 225, discount 50, new 1 / returning 1, CSV.
- [x] 242. Orders by weekday and hour: a 7×24 heatmap of orders and revenue in the store's time zone, for planning confirmation calls and stock. (backend done, UI in frontend-handoff.md)
  - storeReports /order-heatmap: EXTRACT(DOW/HOUR FROM created_at AT TIME ZONE store tz) over live orders; always 168 cells; per-cell COD confirmation rate; weekday/hour totals and the busiest cell.
  - Found afterwards: analytics/reportsService.js salesBreakdowns already returns orders by weekday × hour (`dow`, `hour`) inside the sales report. This endpoint adds revenue, the per-cell confirmation rate, CSV, totals and the busiest cell; the UI may use either. Gap passes must also read report breakdowns, not only module names.
  - Verified: two orders at 18:30/18:45 UTC on Thu 1 Oct → Thursday 21:00 Cairo, one on Sat 07:10 UTC → Saturday 10:00; rates 50% and 100%.

## Twelfth pass (2026-10-07) — operations and reports gap pass

How the list was made: modules searched under several spellings and the existing report breakdowns read (after
item 242 overlapped a sales-report breakdown). Not listed because already built: product import from sheets
(creates products), order documents (waybills, manifest, invoices, pick list), cohorts, payment-method and source
breakdowns. No migration needed for any item below.

- [x] 243. Bulk stock and price update from a sheet: CSV/xlsx rows by SKU (stock set or ±adjust, price, compare-at, cost), a preview of every change and every unknown SKU, then apply with stock movements and an audit entry. (backend done, UI in frontend-handoff.md)
  - catalog/importExport/bulkUpdate.js (reuses sheetReader), mounted before the catalog router. Stateless: preview and apply both read the sheet; apply sets stock to the target relative to the stock at that moment (inventoryService.adjustStock), prices via variant.update (price history and cache follow).
  - Verified: case-insensitive SKU, set + adjust, prices/compare-at/cost in major units, unknown SKU, duplicates, missing SKU, preview changes nothing, multipart apply, 2 movements, price history rows, missing sku column 422.
- [x] 244. Packing slips: one A4/A5 slip per selected order — lines and quantities, gift message, prices hidden for gift orders that asked for it — as one PDF beside the other order documents. (backend done, UI in frontend-handoff.md)
  - orders/packingSlips.js, POST /orders/documents/packing-slips beside the other documents; A5/A4; prices hidden when giftOptions.hidePrices; pickup orders show the place; Arabic through bidiText; emoji stripped.
  - Verified: gift order (Arabic name/address/message with an emoji, prices hidden) and a normal order (prices and total) rendered and checked as images; empty selection 422.
- [x] 245. Sales by collection: units, orders and revenue per collection in a date range (a product in several collections counts in each), with CSV. (backend done, UI in frontend-handoff.md)
  - storeReports /sales-by-collection: order lines of live orders (stage via STAGE_SQL subquery) × product_collections; units, distinct orders and products, revenue, delivered revenue; uncollected total.
  - Verified: product in 2 collections counted in both (3 units, 2 orders, 300, delivered 200), cancelled order out, lone product in uncollected, CSV.
- [x] 246. Sales by variant option: units and revenue per option value (e.g. size M, colour black) across products, for buying decisions; CSV. (backend done, UI in frontend-handoff.md)
  - storeReports /sales-by-option: jsonb_each_text over order_items.variant_options_snapshot (live orders), grouped by lower(trim(name/value)); share per option; option filter.
  - Verified: M (3 + 2 from " m " on another product) merged to 5 = 83.3%, L 1, Color and Colour kept apart, size filter case-insensitive. Checked afterwards: by design — POST /catalog/products takes a simple first variant (price, sku, stock, weight) and its validator drops other keys; options go through the variants endpoints.
- [x] 247. Returns by reason: return requests per reason and per product, the return rate per product (returned units / delivered units), and refunds given; CSV. (backend done, UI in frontend-handoff.md)
  - storeReports /returns: reason code = split_part(reason, ':', 1) (returns store "code: detail"); units from the items JSON; per-product rate for orders placed in the window (delivered or returned stage) vs non-rejected return units; processed refunds in the window.
  - Verified: 3 orders (8 units delivered), returns damaged ×1 refunded, wrong_item ×2 requested, damaged ×4 rejected → rate 37.5%, reasons with rejected/completed counts, refund 100.

## Thirteenth pass (2026-10-07) — operations gap pass

How the list was made: searched under several spellings first. Not listed because already built: product duplicate
(catalog bulk), dashboard global search, saved views, bulk order tags (orders/bulk add_tag). Left out for now as too
risky without a design pass with the owner: splitting one order into two, merging two orders into one (totals,
payments and courier bookings would all have to follow). No migration needed for any item below.

- [x] 248. Merge duplicate customers: pick the customer to keep and the duplicate; orders, addresses, notes, reviews, wishlist, referrals and every other record move over, points and store credit are added together with a ledger line each, tags and consent merged; the duplicate is removed; audited, refused while either customer has a payment in progress. (backend done, UI in frontend-handoff.md)
  - customers/customerMerge.js, mounted before the customers router. Moves every foreign key to customers (read from pg_constraint, so future tables follow) after dropping the duplicate's rows that would break unique indexes (reviews, enrollments, wishlist, referral code, login codes). Balances added with merge ledger lines; profile gaps filled; duplicate deleted; one transaction with both customers locked; audited.
  - Candidates by email, last-9 phone digits or name.
  - Verified: candidate by email+name, same-id 422, merge moved 2 orders, 1 wishlist (duplicate dropped), 1 note; points 50 and credit 10 added with ledger lines; tags joined; alternate phone filled; duplicate gone.
- [x] 249. Scan to pack: for an order, scan barcodes or type SKUs; the server checks each scan against the order's lines (unknown item, too many, still missing), and when everything is scanned marks the order packed (tag `packed`, timeline entry). (backend done, UI in frontend-handoff.md)
  - Stateless: the page sends every scan so far, the server answers per line expected/scanned/missing/over plus unknown codes — a reload or second device just resends the list; no table, no migration.
  - Codes match the variant barcode, its SKU, or the line SKU snapshot, trimmed and case-insensitive; a variant on two lines is one pile; lines with no variant are listed as manual.
  - Confirm needs a complete scan, or force with a note (an item with no barcode); it adds the tag packed through the order meta service and audits order.packed. Cancelled orders are refused.
- [x] 250. Customer timeline: one feed per customer of orders (placed, delivered, cancelled), returns, refunds, notes and follow-ups, reviews, questions, loyalty and store-credit movements, quotes and privacy requests, newest first, paged. (backend done, UI in frontend-handoff.md)
  - Read-only: one UNION over the tables that already hold each event (orders, shipments, return requests, refunds, notes, follow-ups, reviews, questions, loyalty and credit ledgers, quotes, privacy requests, referrals, form submissions); no table, no migration.
  - Delivered/shipped come from shipments (orders.completed_at is the checkout completion, not delivery). Product questions have no customer link, so they match the customer email.
  - Cursor paging on (time, kind, id) with microsecond time in the cursor, so new events do not shift pages; kinds filter; customers.view.

## Fourteenth pass (2026-10-07) — Lightfunnels parity, second look

The owner, 2026-10-07: "شوف لايت فانل شغال ازاي واعمل زيه". Lightfunnels' own hosts are still blocked here, so this pass compares what is known of their product (search excerpts, their published feature lists) with the code module by module. Already matched and not listed: funnels and steps, split tests, one-click upsells/downsells, bumps, bundles and quantity offers, COD flows, abandoned checkout by email/SMS/WhatsApp (official API), pixels with server events for Meta/TikTok/Snapchat/Google/Pinterest, GTM, Clarity, product feeds, Google Sheets, Zapier-style webhooks, popups, multi-currency, translations, custom domains with a home funnel, floating WhatsApp button (wa.me), shared funnels, store duplication, team roles, public API keys, digital products, subscriptions, courses (LightSchool stays out), reviews import. Migration 499 is the last of this range, so these items avoid migrations.

- [x] 251. More ad platforms for tracking pixels: X (Twitter), Taboola, Outbrain, Kwai, Reddit and Microsoft Ads (UET), with their id formats, and the storefront told which standard events each one takes. (backend done, UI in frontend-handoff.md)
  - Browser tags only: none of the six has a server API wired here (X, Reddit and Microsoft have conversion APIs; they can follow as interface + sandbox adapters when the owner wants server events for them). capiEnabled is forced off, so the relay never targets them; no migration (platform is a string column).
  - The storefront gets each pixel's event names (browserPixelEvents.js), with null where the platform has no such event, so the storefront needs no per-platform table of its own.
  - X conversions are per-pixel event ids made in X Ads Manager (config.eventIds), validated tw-<pixel>-<event>.
- [x] 252. Transfer a store to another owner: the owner hands the store to a member of its team (password confirmed, the new owner told by email); the old owner stays as an admin. (backend done, UI in frontend-handoff.md)
  - The owner is workspaces.owner_user_id (the account the store counts against); only that person can transfer, with their password, to an active team member — invite first, so the new owner has already accepted being on the team. No migration.
  - The store must fit the new owner's plan limits (their stores plus this one), else 409. The plan and subscription stay with the store; the response says whether it is billed outside (external) so the UI can remind them to change the card.
  - keepAs: workspace_manager (default), owner, or leave. Both people get an email ("if this wasn't you, contact support"); audited workspace.ownership_transfer.
- [x] 253. Cart offers: merchant rules that show a product in the cart ("add X for Y% off") when the cart has a product or reaches a subtotal; the offer price is honoured in the cart quote and at checkout. (backend done, UI in frontend-handoff.md)
  - Rules in settings.cart_offers (no migration), the free-gift pattern: percent off or a fixed offer price, a trigger (products and/or the rest of the cart's subtotal), dates, on/off.
  - The offered product never counts toward its own rule, so buying it alone gets the normal price. The offer price covers a line up to maxQuantity; above it the whole line is back at the normal price (simpler and clearer than splitting a line), and the cart says so.
  - The cart prices the line through the same price map as A/B tests and price lists; the checkout pins the same price, only ever lower, before free gifts are worked out. Funnel checkouts keep their own offers. Rules that do not hold yet come back as locked with the missing amount.

## Fifteenth pass (2026-10-07) — after the new ad platforms

- [x] 254. Attribution and ad spend for the six new ad platforms: their utm_source spellings and click ids credit orders, lost checkouts and the campaigns report to X, Taboola, Outbrain, Kwai, Reddit and Microsoft, and ad spend can be entered or imported for them (and for Pinterest). (backend done, UI in frontend-handoff.md)
  - Sources: twitter / x / t.co → x; bing / microsoft / msads → microsoft; taboola, outbrain, kwai, reddit, pinterest as themselves (analytics PLATFORM_OF_SOURCE, which the spend import aliases also use).
  - Click ids kept like fbclid/ttclid/gclid: twclid (X), rdt_cid (Reddit), msclkid (Microsoft), tblci (Taboola) — on the visit (from the landing URL), on the first/last touch, on checkout sessions; a lost checkout with only a click id is credited to its platform. Outbrain and Kwai have no documented click id, so their links need utm_source. No migration (JSONB and string columns).
- [x] 255. Server-side conversions for Reddit, X and Microsoft Ads (interface + sandbox adapter + README each), with the same event ids as the browser tags so each platform counts once. (backend done, UI in frontend-handoff.md)
  - pixelProviders/redditCapi.js, microsoftCapi.js, xCapi.js with a README each; sandbox by default (REDDIT_/MICROSOFT_/X_CAPI_MODE=live to send). Orders go through pixelEvents like the other platforms (Purchase or Lead), storefront events through the browser relay.
  - X signs with OAuth 1.0a, so its sealed token is the four keys joined by colons (checked on save); its conversions are the pixel's X event ids (config.eventIds) and need an identifier, so anonymous storefront events go only with a twclid. Its test event answers skipped (X has no page-view conversion).
  - Reddit uses the pixel id as the ad account id and the test event code as test_mode; Microsoft sends pageLoad for page views. Click ids (rdt_cid, twclid, msclkid) come from the order's touch or the visit (item 254).
  - A relayed event a platform does not take is now reported as skipped and not logged as sent (also true for Pinterest's missing events).

## Sixteenth pass (2026-10-07) — measuring the cart offers

- [x] 256. Cart offers and free gifts report: each rule's orders, units and revenue, and how big those orders are against the store's average; order lines show the rule they came from. (backend done, UI in frontend-handoff.md)
  - A plain line the checkout priced from a cart offer, or added as a free gift, keeps the rule's name in order_items.offer_name_snapshot (a line label symbol the order service reads, like the pinned price); invoices and the order page already print that column. No migration.
  - GET /store-reports/cart-offers groups those lines by rule name (gift = every line at 0). Orders before this change have no label and are not counted. Cancelled and test orders are left out.
- [x] 257. The pixels screen says, per platform and per pixel, whether its server events really go out (live) or are only built and logged (sandbox). (backend done, UI in frontend-handoff.md)
  - serverMode: 'live' for Meta, TikTok, Snapchat and Google (no sandbox switch), the provider's *_CAPI_MODE for Pinterest, Reddit, Microsoft and X, null where there is no server API. Read from the environment, so the owner turns a platform live without a code change.
- [x] 258. Spin to win, the honest kind: a wheel of the store's real coupons and "no prize" slices, drawn on the server by the slices' weights, every slice's real chance shown, one spin per phone with marketing consent. (backend done, UI in frontend-handoff.md)
  - §21: no rigged wheel — the draw is server-side (crypto.randomInt over the weights) and the storefront gets the exact chance of each slice to show; a coupon that has ended or is used up leaves the draw and the chances shown are recomputed without it. No wheel is shown when no prize can be won.
  - It is a sign-up, said so on its face: phone + a required consent tick; the person becomes a contact tagged spin_wheel (lead.created, plan lead limit, opt-out cleared) like the newsletter. One spin per phone (advisory lock + the tag); no migration — config in settings.spin_wheel, spins counted from the audit log.
- [x] 259. Order export: an «Offer» column per line (the offer, bundle, cart offer or free gift it came from), for one-row-per-product exports. (backend done, UI in frontend-handoff.md)
  - Reads order_items.offer_name_snapshot, which funnel offers already filled and item 256 now fills for cart offers and gifts. One column added to the item columns; no other change.

## Seventeenth pass (2026-10-07) — SPEC §4–§20 audit against the code

An audit of every SPEC section against the code (more than 250 named capabilities checked) found these left. A full partner OAuth app system (§16.3, P2) needs new tables; queued as 265 now that the owner's "don't ask, build it like Lightfunnels" (2026-10-07, LANES) opened migrations 500–549.

- [x] 260. Excel (xlsx) for lost orders and courier tracking: `format=xlsx` on the lost-orders export (§6.3) and an xlsx upload on `POST /orders/import-tracking` (§12.3, manual carriers). (backend done, UI in frontend-handoff.md)
  - The lost-orders export builds one table for both formats; xlsx comes back base64 in the JSON like the CSV text (the dashboard builds the file), through the existing xlsx writer.
  - Tracking import reads xlsx with the existing sheet reader (cells as text, blank rows dropped); everything after the parse is the CSV path unchanged. No migration.
- [x] 261. Ad accounts (§15.4): connect / list / remove an ad platform account (the merchant picks the accounts), so the daily spend sync has something to pull; pause, resume and change the budget of a campaign from ZIMOS (P2) — adapter methods with the sandbox adapter. (backend done, UI in frontend-handoff.md)
  - profit/adAccounts.js under /profit/ads: adapters, connections (one workspace_integrations row per adapter, credentials sealed), the merchant's account pick (config.selectedAccountIds, which the spend sync passes to the adapter), disconnect, and campaign pause/resume and daily budget. No migration.
  - The adapter contract (adapters/README.md) gains listAdAccounts, setCampaignStatus and setCampaignBudget; the sandbox adapter answers like a platform and changes nothing. A refusal (ok:false) is a 422 and nothing is recorded; the last status and budget set from ZIMOS are kept per account:campaign for the screen, the platform stays the source of truth.
- [x] 262. Merchant sign-in with a WhatsApp code (§20.1): request a code to the verified phone, verify, get a session — with the same new-device and lockout rules as the password sign-in. (backend done, UI in frontend-handoff.md)
  - auth/whatsappLogin.js reuses login_challenges (channel wa_login) and the WhatsApp→SMS sender of the WhatsApp second step: 10 minutes, 5 tries, 5 codes per 10 minutes per account. No migration.
  - The code replaces the password, not the second step: an account with an authenticator app or email codes still passes it (unless the browser is remembered); a WhatsApp second step is not asked twice. Backup codes never work here, and the two-factor endpoint refuses wa_login challenges.
  - Enumeration-safe answer (decoy token, the typed number masked the same way). Known limits: the 429 and the 503 (code not delivered) only happen for real accounts; accepted, as for the SMS password reset. Only a phone verified on exactly one active account signs in.
- [x] 263. Dropship suppliers (§16.5): "use the supplier's shipping rates" and "refuse an order below the supplier's minimum" — optional adapter methods, a provider setting, and the hooks in the shipping quote and checkout. (backend done, UI in frontend-handoff.md)
  - dropship/supplierRules.js: two switches on the supplier connection (config), each needing an optional adapter method (shippingQuote, minimumOrder; contract in providers/README.md, the sandbox supplier implements both). Only suppliers that are connected and whose app is on count. No migration.
  - Supplier shipping: only for an order that is all that supplier's products, and only in place of a destination price — the store's free-shipping rules (all free, threshold, offer override) still win and the merchant pays for them; a failed quote falls back to the store's rate. The same in the order and in the storefront quote.
  - Minimum: counted on that supplier's lines only; shoppers only (not orders typed in by the team, like the store's own minimum); a supplier that can't answer doesn't block orders. The quote shows the gap before checkout. Supplier answers cached 10 minutes.
- [x] 264. Product feeds per channel (§7.8, §7.10): each channel (Google, Meta, TikTok, Snapchat) with its own on/off, collections and stock rule; optionally keep the Google feed off until the Merchant checklist passes. (backend done, UI in frontend-handoff.md)
  - settings.product_feed.channels.<channel> = { enabled, collection_ids, exclude_out_of_stock, require_checklist }; null follows the store-wide setting, so a store that never sets channels keeps exactly its old feeds. No migration.
  - Each channel is built and cached on its own; the public link answers 404 for a channel switched off, or for Google held back by an unfinished Merchant checklist (the merchant's choice). The checklist now reads the Google feed's own items. The GET reports per channel whether it is live and how many items it holds.
- [x] 265. Partner apps with OAuth (§16.3, like Lightfunnels' app platform): registered apps (client id / secret, redirect URIs, scopes), the authorization-code flow and token exchange with refresh, tokens that work on the public API with the granted scopes, uninstall/revoke; embedded (iframe) app pages. App charges stay out (§17.4). Migrations from 500. (backend done, UI in frontend-handoff.md)
  - Migration 500 (partner_apps, oauth_codes) — the first of the 500–549 range. The client secret is sealed, not hashed, because it also signs the app's page address (HMAC).
  - Access tokens are public-API keys (api_keys) with the approved scopes, acting as the approving person (never beyond their role), held by a workspace_apps install (kind external), so the public-API gate, the Apps page and the existing uninstall all work unchanged. Long-lived until uninstall or revoke — no refresh tokens (like Shopify's offline tokens); approving again replaces the token.
  - Codes: 10 minutes, one use (atomic claim), bound to the app and the exact redirect URI. Redirects must be registered https (http only for localhost). Development apps install only on their developer's stores; the platform publishes or suspends (suspending removes installs).
  - Embedded page: a signed address (store, user, timestamp) the app verifies; the frame itself is the dashboard's. App charges stay out (§17.4).
