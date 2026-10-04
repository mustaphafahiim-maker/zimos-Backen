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
- [ ] 115. The rich footer shows the policy links, footer pages and social links (§8.3).
- [ ] 116. Automation conditions work on checkout, lost-order, lead and subscription triggers (§14.2).
- [ ] 117. Trial subscriptions shown and counted in the subscriptions screen (§18.1).
- [ ] 118. "Convert to order" keeps the coupon, the funnel and the custom answers, and cannot create two orders (§6.3).
- [ ] 119. Recovery automations mark the lost order contacted; the ready-made recovery timing as the spec says (§6.4).
- [ ] 120. The tracking page accepts the store's own country's phones (§14.7).
- [ ] 121. The store's country on the server: phones, OTP, the risk score and allowed countries (§5.2, §5.5).
- [ ] 122. Payment methods offered only when they take the order's currency; payment fees, shipping and the free-shipping threshold in the funnel's currency (§11.5).
- [ ] 123. Shipping prices by region from the platform's places: North Coast, Saudi regions, hiding a region, one price for all (§12.1).
- [ ] 124. Root domains and www: an A/ALIAS record option and the www redirect (§8.11).
- [ ] 125. Product feed items land on their own variant (§7.8).
- [ ] 126. An order bump on a funnel product page's COD form, and the product's own bumps there (§9.5, §10.3).
- [ ] 127. COD settlement statements read from the courier's Excel file (§15.5).
- [ ] 128. The builder product list's "Featured" and "Best selling" sources honoured (§8.2).
- [ ] 129. A failed payment marks the order and fires the event, also when the gateway refuses to start it (§11.4).
- [ ] 130. A rejected transfer: the shopper is told and can upload a new receipt (§11.3).
- [ ] 131. The deposit rule reads the platform-wide delivery rate (§11.3).
- [ ] 132. Lost orders keep their traffic source (§6.1).
- [ ] 133. The merchant sets when a checkout counts as lost (§6.2).
- [ ] 134. "Notify the customer" on status changes, one order or many (§4.6).
- [ ] 135. The order timeline shows the messages sent to the customer (§4.4).
- [ ] 136. Orders list and order page: product images, the funnel's name as the source, "New customer" (§4.3, §4.4).
- [ ] 137. Dropship: send an order to the supplier from the order page, forward automatically, follow its status (§16.5).
- [ ] 138. The order.status_changed webhook carries old_status and new_status (§16.1).
- [ ] 139. Contact tags from purchase buttons on website pages too (§18.4).
- [ ] 140. Subscribers get their portal link (§18.1).
- [ ] 141. The store's subdomain can be changed in settings (§17.3).
- [ ] 142. New-order notifications name the product and governorate, in the teammate's language (§20.1).
- [ ] 143. AI store policies applied to the store's policies (§19.2).
- [ ] 144. Product pickers in the builder instead of pasted IDs, with "Edit product" (§9.3).
- [ ] 145. Funnel page editor: tablet preview, previous/next page, select the parent element (§9.3).
- [ ] 146. Split tests with more than two versions (§9.6).
- [ ] 147. Copy a coupon's share link (§10.5).
- [ ] 148. Page settings Details tab: a generic page's address and its title (§9.3).
- [ ] 149. Translations for product content, offer text, option values, policies, store info, the thank-you text and menu labels (§8.10).
- [ ] 150. Formatted product descriptions, sanitized (§7.1).
- [ ] 151. A "track quantity" switch for physical products; variant prices labelled in the store's currency (§7.1).
- [ ] 152. A currency switcher on attribution, reports and profit (§11.5).
- [ ] 153. Order export presets in a courier's own layout (§12.3).
- [ ] 154. The Pinterest tag (§13.1).
- [ ] 155. Google Sheets sync for orders and lost orders: adapter + sandbox + README (§16.4).
- [ ] 156. The dashboard home remembers its period; bulk tagging from the contacts list (§15.1, §18.4).

Not queued (decided already or waiting on the owner): cross-sell discounts and "once per customer" by phone/email (lane 3), the full style/layout tab list (lane 5), city/district shipping prices (decision 19 keeps the city as free text), service ratings (lane 8: no fake ratings), a niche-template wizard card (decision 75).

§5 (fraud) and §22 Gate 1 (no mock pages, no mockCommerce.ts) are complete.
