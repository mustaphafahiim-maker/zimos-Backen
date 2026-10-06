# Backend → frontend handoff

The backend chat appends one section per item it builds. The frontend chat
builds every screen, api-client call and storefront change described here and
ticks its own file (`docs/ux/backend-requests.md` in zimos-front). "UI:
pending" means the backend is done and the screens are not.

All staff paths are under `/api/v1`, need `Authorization: Bearer <token>`,
and answer errors as `{ "error": { "code", "message", "details?" } }`.

---

## 160. Editable storefront texts per language — UI: pending

The merchant rewords the storefront's own labels (buttons, form errors, cart,
checkout, bundle wording) per language. Only the overrides are stored; the
defaults stay in `apps/storefront/src/lib/i18n.ts`.

### Endpoints

**GET `/workspaces/:workspaceId/storefront-texts`** — permission `website.edit`

```json
{
  "texts": { "ar": { "checkout.placeOrder": "اطلب دلوقتي" }, "en": { "checkout.placeOrder": "Order now" } },
  "limits": { "maxKeysPerLocale": 400, "maxText": 500, "locales": ["ar", "en", "fr", "es", "it", "de"] }
}
```

**PUT `/workspaces/:workspaceId/storefront-texts`** — permission `website.edit`.
Replaces every override (send the whole object). Answers like GET.

```json
{ "texts": { "ar": { "checkout.placeOrder": "اطلب دلوقتي", "form.errors.summary": "صحح {n} خانة" }, "en": {} } }
```

Validation (422 `VALIDATION_ERROR`, `details: [{ path, message }]`, one entry per problem,
path like `"ar.checkout.placeOrder"`):
- language: one of `limits.locales`;
- key: the dictionary path, `section.key` with 2–4 dot parts, letters/digits
  (regex `^[a-z][A-Za-z0-9]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39}){1,3}$`);
- text: a string, trimmed, control characters removed, at most 500 characters;
  a blank text (or `null`) drops the override, so the default shows again;
- at most 400 texts per language.

Texts are plain text — render them as text, never as HTML. `{name}`-style
placeholders are kept as written: for dictionary entries that are functions
(`cart.cartWithCount(n)`, `product.youSave(amount)`, `form.errors.summary(n)`),
the storefront fills the placeholder named after the function's argument
(`{n}`, `{amount}`, `{price}`, `{pct}`, `{name}`).

**GET `/store/:workspaceId`** (public) — `store.storefrontTexts` now holds the
same object (`{}` when none). Cached for at most 60 s, dropped on save.

### Storefront
- In `StoreContext.build()` (and `getDictionary` for server components), deep-
  merge `store.storefrontTexts[locale]` over the dictionary: for each
  `"a.b.c": text`, replace `dict.a.b.c`; when the default is a function, wrap
  it as `(...args) => text with {argName} replaced`. Unknown keys are ignored.

### Dashboard screen — Website → Store texts (`website.edit`)
- Language tabs (the store's languages from the translations settings; ar and
  en always).
- Grouped list by dictionary section (Buttons & common, Product, Form & errors,
  Order bump, Cart, Checkout, Upsell, Thank you, Tracking, Footer). Each row:
  the default text (read-only, from the dashboard's copy of the storefront
  dictionary keys), an input for the override, a "Reset" link when overridden.
  Show the placeholders a row accepts (`{n}`) under the input.
- Search box over keys and default texts; "Show changed only" toggle.
- Save button (PUT the whole object), toast on success, field errors from
  `details[].path` shown on the matching row.
- States: loading, error (retry), no permission, empty (nothing changed yet:
  "All texts use the default wording").

Wording:
| en | ar |
|---|---|
| Store texts | نصوص المتجر |
| Change the words shoppers see on buttons, forms, cart and checkout. | غيّر الكلام اللي العميل بيشوفه على الأزرار والفورم والسلة وصفحة الطلب. |
| Default | النص الافتراضي |
| Your text | النص بتاعك |
| Reset | رجّع الافتراضي |
| Show changed only | اعرض المتغيّر بس |
| All texts use the default wording | كل النصوص على الكلام الافتراضي |
| Saved | اتحفظ |
| Placeholders: {n} | المتغيرات: {n} |

---

## 161. Store scripts by position and page type — UI: pending

Named snippets of the merchant's own code, each placed in `<head>`, right
after `<body>` opens, or before `</body>`, and run only on the page types it
names. Same safety rules as the existing custom code: `website.publish` to read
or write, every change audited, never served to a staff preview, run only on
the store's own host and never on the card payment pages.

### Endpoints (permission `website.publish`)

**GET `/workspaces/:workspaceId/custom-code/store-scripts`**

```json
{
  "scripts": [
    { "id": "025235b84454", "name": "Hotjar", "position": "head", "pages": ["all"], "code": "<script>…</script>",
      "isActive": true, "sortOrder": 1, "updatedAt": "2026-10-06T18:16:29.230Z", "updatedBy": "<userId>" }
  ],
  "options": { "positions": ["head", "body_start", "body_end"],
    "pageTypes": ["all", "home", "collection", "product", "page", "funnel", "cart", "checkout", "thank_you"],
    "maxScripts": 30, "maxCodeLength": 50000 }
}
```

**POST `/workspaces/:workspaceId/custom-code/store-scripts`** → 201 `{ "script": {…} }`

```json
{ "name": "Chat widget", "position": "body_end", "pages": ["product", "checkout"], "code": "<script>…</script>", "isActive": true }
```
- `name` 1–60 chars (required); `position` one of `options.positions` (required);
  `pages` non-empty unique subset of `options.pageTypes` (default `["all"]`;
  `"all"` with others collapses to `["all"]`); `code` ≤ 50 000 chars, stored
  as typed (required, may be `""`); `isActive` (default true); `sortOrder`
  0–10000 (default: after the last).
- 422 `VALIDATION_ERROR` "A store keeps at most 30 scripts".

**PATCH `/workspaces/:workspaceId/custom-code/store-scripts/:id`** — any of the
fields above (at least one) → `{ "script": {…} }`. 404 `NOT_FOUND` when unknown.

**DELETE `/workspaces/:workspaceId/custom-code/store-scripts/:id`** → `{ "deleted": true, "id": "…" }`

**GET `/store/:workspaceId/custom-code`** (public) now also returns
`scripts: [{ id, position, pages, code }]` — active, non-empty, in order;
`[]` in a preview.

### Storefront
- Where the store's custom code is injected today, also inject each script
  whose `pages` contains `"all"` or the current page type: `home` (store home),
  `collection`, `product`, `page` (merchant's custom pages), `funnel` (funnel
  steps), `cart`, `checkout`, `thank_you` (store or funnel thank-you).
- `head` → in `<head>`; `body_start` → first thing in `<body>`; `body_end` →
  before `</body>`. Run inline scripts the same way the existing `head`/`js`
  slots are run (re-created `<script>` elements so they execute). Same host
  and payment-page guards as the existing custom code.

### Dashboard screen — Settings → Custom code → "Scripts" tab (`website.publish`)
- Table: name, position, pages (chips), active toggle, updated date; row
  actions edit / delete (confirm). "Add script" button (disabled at 30 with
  the reason). Up/down to reorder (PATCH `sortOrder`).
- Drawer/modal form: name, position (radio: Head / Body start / Body end),
  pages (checkbox list with "All pages" that disables the others), code
  (monospace textarea, counter vs 50 000), active switch.
- Warning banner: code runs on the live store only, not in preview.
- States: loading, error, empty ("No scripts yet"), no permission.

Wording:
| en | ar |
|---|---|
| Scripts | السكريبتات |
| Add your own code to the store and choose where and on which pages it runs. | ضيف كود بتاعك للمتجر واختار مكانه والصفحات اللي يشتغل فيها. |
| Add script | إضافة سكريبت |
| Position | المكان |
| Head | داخل head |
| Body start | أول الـ body |
| Body end | آخر الـ body |
| Pages | الصفحات |
| All pages / Home / Collection / Product / Custom pages / Funnel steps / Cart / Checkout / Thank you | كل الصفحات / الرئيسية / المجموعة / المنتج / الصفحات الخاصة / خطوات الفانل / السلة / إتمام الطلب / صفحة الشكر |
| Code runs only on your live store, not in the editor preview. | الكود بيشتغل على المتجر الحقيقي بس، مش في المعاينة. |
| No scripts yet | مفيش سكريبتات لسه |
| A store keeps at most 30 scripts | المتجر ياخد ٣٠ سكريبت بالكتير |

---

## 162. Smart collections by tags, and an "All products" collection — UI: pending

A collection with `rules` fills itself; membership is kept as normal collection
links, so the store's collection pages, filters and counts need **no change**.

### Rules (on the existing collection endpoints)

`POST /workspaces/:ws/catalog/collections` and `PATCH /workspaces/:ws/catalog/collections/:id`
(permission `products.manage`) now validate `rules`:

```json
{ "rules": { "type": "tags", "match": "any", "tags": ["summer", "sale"] } }
{ "rules": { "type": "all_products" } }
{ "rules": null }
```
- `match`: `any` (default) or `all`; `tags`: 1–20 strings, 1–100 chars each, matched case-insensitively against product tags.
- `null` makes it a manual collection again (current links stay, editable by hand).
- Saving rules re-fills the collection at once; creating a product or changing its tags updates its smart collections at once.
- 422 `VALIDATION_ERROR` (`field: "rules"`) on a bad shape.
- Adding/removing a product by hand on a smart collection (single or bulk edit) → 409 `SMART_COLLECTION`. Reordering still works.

### New endpoints (permission `products.manage`)

**POST `/workspaces/:ws/smart-collections/all-products`** body `{ "name": "All products" }` (optional, default "All products").
Creates the store's "All products" collection (slug `all`, rules `all_products`) once;
→ 201 `{ "collection": {…}, "created": true }`, or 200 `{ "collection": {…}, "created": false }` when it exists.

**POST `/workspaces/:ws/smart-collections/:collectionId/sync`** → `{ "id": "…", "added": 2, "removed": 0 }`.
Re-fills one smart collection by hand. 409 `NOT_SMART_COLLECTION` for a manual one.

### Dashboard — Products → Collections
- Collection form: a "Collection type" choice: **Manual** / **Automatic (by tags)** / **All products**.
  Automatic shows: a tag input (chips, from the store's existing tags if available), and
  "Products must match: any tag / all tags".
- Collection list: a badge "Automatic" on smart collections; product count as today.
- Collection page: for a smart collection, hide "Add products" and the per-product remove,
  show a note with the rule ("Products tagged summer or sale") and a "Refresh" button (sync).
- Empty state of the collections list: a button "Create 'All products' collection" (POST all-products).
- Map 409 `SMART_COLLECTION` to a toast.

Wording:
| en | ar |
|---|---|
| Collection type | نوع المجموعة |
| Manual | يدوي |
| Automatic (by tags) | تلقائي (بالتاجز) |
| All products | كل المنتجات |
| Products must match | المنتجات لازم تطابق |
| any tag / all tags | أي تاج / كل التاجز |
| Automatic | تلقائي |
| Products tagged {tags} join this collection by themselves. | المنتجات اللي عليها {tags} بتدخل المجموعة لوحدها. |
| Refresh | تحديث |
| Create "All products" collection | اعمل مجموعة "كل المنتجات" |
| This collection fills itself from its rules. | المجموعة دي بتتملى لوحدها من الشروط بتاعتها. |

---

## 163. The store's own places: regions → cities → areas — UI: pending

A store keeps its own three-level place list per country (typed, imported from
a sheet, or copied from the platform's governorates and cities), and the
checkout picks the address from it in three dropdowns.

### Staff endpoints (permission `shipping.manage`)

**GET `/workspaces/:ws/store-places?country=EG`** (country defaults to the store's)

```json
{ "country": "EG", "counts": { "region": 2, "city": 2, "area": 3 }, "max": 5000,
  "places": [ { "id": "…", "level": "region", "parentId": null, "nameAr": "القاهرة", "nameEn": "Cairo", "geoCode": "cairo",
               "sortOrder": 1, "hidden": false,
               "children": [ { "id": "…", "level": "city", "nameAr": "مدينة نصر", "nameEn": "Nasr City", "geoCode": "cairo.nasr-city",
                               "children": [ { "id": "…", "level": "area", "nameAr": "الحي العاشر", "nameEn": "10th District", "geoCode": null } ] } ] } ] }
```
Areas have no `children` key.

**POST `/workspaces/:ws/store-places`** → 201 `{ "place": {…} }`
```json
{ "country": "EG", "level": "area", "parentId": "<city id>", "nameAr": "مكرم عبيد", "nameEn": "Makram Ebeid", "hidden": false }
```
- `level` region|city|area; a city needs a region `parentId`, an area a city `parentId` (422 / 404 otherwise);
- names 1–120 chars, `nameEn` defaults to `nameAr`; at most 5000 places per country.
- `geoCode` is filled by the server when the platform's list knows the region/city name (keeps governorate prices and courier maps working).

**PATCH `/workspaces/:ws/store-places/:id`** `{ nameAr?, nameEn?, hidden?, sortOrder? }` → `{ "place": {…} }`.
Hidden places (and everything under them) disappear from the checkout.

**DELETE `/workspaces/:ws/store-places/:id`** → `{ "deleted": true, "id": "…" }` — deletes its children too (confirm in UI).

**POST `/workspaces/:ws/store-places/import`** — multipart: `file` (CSV or .xlsx, ≤ 2MB, ≤ 5000 rows),
`country` (EG), `mode` (`merge` default — adds, reusing names already there; `replace` — clears the country first).
Columns (first row): `region_ar, region_en, city_ar, city_en, area_ar, area_en`; a row may stop at region or city.
→ `{ "country": "EG", "mode": "merge", "created": 6, "total": 6, "errors": [ { "row": 5, "message": "An area needs its city" } ] }`
(422 `INVALID_FILE` for an unreadable file or missing header.)

**POST `/workspaces/:ws/store-places/copy-platform`** `{ "country": "EG" }` → same answer as import.
Copies the platform's governorates and cities (Egypt 28 + 344 cities; Saudi regions); then the merchant adds areas.

### Public (storefront)

**GET `/store/:ws/places?country=EG`**
```json
{ "country": "EG", "source": "store",
  "places": [ { "id": "…", "ar": "القاهرة", "en": "Cairo", "code": "cairo",
               "children": [ { "id": "…", "ar": "مدينة نصر", "en": "Nasr City", "code": "cairo.nasr-city",
                               "children": [ { "id": "…", "ar": "الحي العاشر", "en": "10th District", "code": null } ] } ] } ] }
```
With no own list: `source: "platform"`, governorates → cities (ids `null`, no areas), minus the store's hidden places.

### Checkout address
The checkout, lost-order and staff order address now also take `area` (≤ 120) and `placeId` (uuid of
the deepest place picked from the store's list). Send `province` = region name, `city` = city name,
`area` = area name, `placeId` = the area's (or city's) id. Item 164 prices shipping from `placeId`.

### Screens
- **Dashboard → Shipping → Places** (`shipping.manage`): country select; a three-column
  browser (Regions | Cities | Areas) or an expandable tree; add / rename / hide / delete at
  each level; counts; buttons "Import sheet" (file + merge/replace + downloadable sample CSV with the
  six columns) and "Start from the platform list". Import result: created count and the row errors table.
  States: loading, empty ("No places yet — import a sheet or start from the platform list"), error, no permission.
- **Storefront checkout**: when `source = "store"`, three dependent selects Region → City → Area
  (Area only when the chosen city has areas); fill province/city/area/placeId. With `source = "platform"`,
  keep today's governorate + city behaviour.

Wording:
| en | ar |
|---|---|
| Places | المناطق |
| Region / City / Area | المحافظة / المدينة / المنطقة |
| Add region / Add city / Add area | إضافة محافظة / إضافة مدينة / إضافة منطقة |
| Import sheet | استيراد شيت |
| Add to the list / Replace the list | إضافة للقائمة / استبدال القائمة |
| Start from the platform list | ابدأ من قائمة المنصة |
| Hidden from checkout | مخفية من صفحة الطلب |
| Deleting a region deletes its cities and areas. | حذف المحافظة بيحذف مدنها ومناطقها. |
| No places yet — import a sheet or start from the platform list. | مفيش مناطق لسه — استورد شيت أو ابدأ من قائمة المنصة. |
| Choose your area | اختار منطقتك |

---

## 164. Shipping prices per city and area — UI: pending

Each place of the store's own list (item 163) can carry a shipping price. The
deepest priced place of the shopper's address wins (area → city → region); with
none, the store's governorate prices and zones apply as before. Only in the
"rates" pricing mode (weight tiers keep their own table).

### Data
`shippingAmount` (integer minor units, or `null` = not priced here) is now on every
place in `GET /workspaces/:ws/store-places` and accepted by POST and PATCH there
(0 … 100 000 000; `null` clears).

### Endpoints (permission `shipping.manage`)

**PUT `/workspaces/:ws/store-places/prices`** — save the prices table in one go
```json
{ "prices": [ { "id": "<place id>", "shippingAmount": 4500 }, { "id": "<place id>", "shippingAmount": null } ] }
```
→ `{ "changed": 2 }`. 422 when an id is not the store's. Up to 5000 rows, unique ids.

**POST `/workspaces/:ws/store-places/import`** — the sheet may add a `shipping` column (also read as
`shipping_price` or `price`): the price of the row's deepest place, **in major units** of the store's
currency (`45`, `45.50`, Arabic digits accepted; empty = leave as is). Answer adds `"priced": 3`;
a non-number gives a row error "The shipping price is not a number".

### Storefront
- **POST `/store/:ws/shipping-quote`** now also takes `city`, `area` and `placeId` (besides `country`,
  `governorate`). Send them as soon as the shopper picks, and re-quote on every change. The quote's
  rule is `"store_place_rate"` when a place price applied.
- Checkout: send `shippingAddress.placeId` (deepest picked place) plus the names in
  `province` / `city` / `area`. A hidden place → 422 `SHIPPING_PLACE_UNAVAILABLE`
  (field `shippingAddress.placeId`); an id not in the list → 422 `VALIDATION_ERROR`. Show the
  message under the pickers.
- Without `placeId`, the server matches the names (Arabic or English, case-insensitive), so
  staff orders and older forms are priced too.

### Dashboard — Shipping → Places (from item 163)
- A "Shipping price" column on every row (money input in the store's currency; empty = "uses
  {parent}'s price" / "uses the governorate price"), saved with PUT `/prices` (Save button,
  dirty-state warning). Show the effective price in grey when inherited.
- Import dialog: mention the optional `shipping` column; the sample CSV gets it.
- Order page: the shipping line shows "City/area price" when `shippingSnapshot.rule = "store_place_rate"`.

Wording:
| en | ar |
|---|---|
| Shipping price | سعر الشحن |
| Uses {name}'s price | بياخد سعر {name} |
| Uses the governorate price | بياخد سعر المحافظة |
| City/area price | سعر المدينة/المنطقة |
| Prices saved | الأسعار اتحفظت |
| The store does not deliver to this area | المتجر مش بيوصل للمنطقة دي |

---

## 165. Checkout file field and optional billing address — UI: pending

### Settings (existing endpoint `PATCH /workspaces/:ws`, `settings.checkout_settings`)
- A custom field (`custom_1` … `custom_5`) may now have `"type": "file"` (besides `text`, `choice`):
  ```json
  { "settings": { "checkout_settings": { "fields": [ { "key": "custom_1", "enabled": true, "required": true, "type": "file",
      "label": { "ar": "صورة البطاقة", "en": "ID photo" } } ], "billing_address": "on" } } }
  ```
- `billing_address`: `"off"` (default) | `"on"`.
- `GET /store/:ws` → `store.checkout.fields[]` carries `type: "file"`, and `store.checkout.billing_address`.

### Storefront checkout
**File field** (photos only: JPEG, PNG, WebP; up to 15MB raw):
1. On pick, `POST /store/:ws/uploads` (multipart `file`, header `X-Visitor-Id: <the visitor id the storefront already keeps>`)
   → `{ "upload": { "uploadId": "…", "mime": "image/jpeg", "width": 20, "height": 20, "expiresAt": "…" } }`.
   Show a thumbnail (from the local file) and "Change"/"Remove".
2. Send the id as the answer: `formFields: { "custom_1": "<uploadId>" }`, and send the **same `X-Visitor-Id` header on the checkout request**.
- Errors: 422 `formFields.custom_1` "\"custom_1\" is required" (required and empty); "The photo is missing or has expired — upload it again"
  (wrong visitor, expired after 48h, or unknown id); upload 415 `UNSUPPORTED_MEDIA_TYPE`, 429 `TOO_MANY_PENDING_UPLOADS`.

**Billing address** (when `billing_address = "on"`): a checkbox "Billing address same as shipping", ticked by default.
Unticked → a billing block: full name (optional), country, region, city, area, address line, postal code; send
```json
{ "billingSameAsShipping": false,
  "billingAddress": { "fullName": "Co LLC", "country": "EG", "province": "الجيزة", "city": "الدقي", "addressLine": "12 Tahrir", "postalCode": "" } }
```
`country`, `city`, `addressLine` are required when unticked (422 fields `billingAddress.city` etc.). Ticked: send nothing (or `true`).

### Dashboard
- **Settings → Checkout form**: the custom-field type select gains "Photo upload"; a switch
  "Ask for a billing address" (`billing_address` on/off).
- **Order page**: `order.checkoutFields[]` entries with `type: "file"` carry `url` (signed, short-lived) and
  `urlExpiresAt` — show a thumbnail that opens the photo; `value` is "📎" (also in the order note line).
  `order.billingAddressSnapshot` (null = same as shipping) → a "Billing address" card under the shipping one;
  when null show "Same as shipping" only if the store has billing on.

Wording:
| en | ar |
|---|---|
| Photo upload | رفع صورة |
| Upload a photo | ارفع صورة |
| Change / Remove | تغيير / حذف |
| The photo is missing or has expired — upload it again | الصورة مش موجودة أو انتهت صلاحيتها — ارفعها تاني |
| Ask for a billing address | اطلب عنوان الفاتورة |
| Billing address same as shipping | عنوان الفاتورة نفس عنوان الشحن |
| Billing address | عنوان الفاتورة |
| Same as shipping | نفس عنوان الشحن |

---

## Frontend request — order search by the last digits of a phone — done

From `docs/ux/backend-requests.md` (audit U-35).

**GET `/workspaces/:ws/orders?q=5678`** (permission `orders.view`, unchanged endpoint and answer).
`q` made only of 4–9 digits (spaces, `+`, `-`, brackets allowed) now also matches orders whose phone **or second phone**
ends with those digits. 10+ digits keep the exact "last ten digits" match; 1–3 digits only match order numbers.
Names/emails/order numbers/waybills still match as before (any of them).
The ⌘K search (`GET /workspaces/:ws/search`) already matched 4+ digits anywhere in the phone; unchanged.

UI: nothing new needed — the Orders list and ⌘K just send the digits. Suggested placeholder:
"Order #, name, phone or its last 4 digits" / «رقم الطلب أو الاسم أو التليفون أو آخر ٤ أرقام».

---

## Frontend request — the Fulfillment role can book couriers — done

From `docs/ux/backend-requests.md`. Decision: booking and following couriers accepts **`orders.manage` or
`shipping.manage`** (the Fulfillment role has `shipping.manage`; no new permission, no role change).

Now open to `shipping.manage`:
- `POST /workspaces/:ws/orders/:orderId/shipments` (book / record a shipment)
- `PATCH /workspaces/:ws/orders/:orderId/shipments/:shipmentId`
- `POST /workspaces/:ws/orders/:orderId/shipments/:shipmentId/sync`, `GET …/label`
- `PUT/DELETE` the shipping card's draft (`shipmentDraft`)
- `POST /workspaces/:ws/orders/bulk` **only when `action: "ship"`** (every other bulk action still needs `orders.manage`)
- everything under `/workspaces/:ws/shipment-batches` (bulk ship preview, start, list, retry)
- `POST /workspaces/:ws/orders/import-tracking`

Unchanged: editing, cancelling, tagging and confirming orders still need `orders.manage` / `orders.confirm`.
A COD order must still be confirmed before booking (409 `ORDER_NOT_CONFIRMED`).
Analytics: the Fulfillment role has no `analytics.view` on the backend (matches the frontend's intended rule).

UI: show "Book courier" (order page and the list's bulk bar) to users with `orders.manage` **or** `shipping.manage`;
keep the other bulk actions behind `orders.manage`.

---

## Frontend request — "postponed" with a callback time — done

From `docs/ux/backend-requests.md` (U-31). «كلّمني بكرة الساعة ٥» is kept and drives when the order is due again.

**POST `/workspaces/:ws/confirmation-tasks/:taskId/outcome`** (permission `orders.confirm`, agent holding the task):
```json
{ "outcome": "postponed", "notes": "كلمني بكرة الساعة ٥", "callbackAt": "2026-10-07T14:00:00.000Z" }
```
- `callbackAt`: ISO date-time, in the future, at most 60 days ahead; allowed with `postponed` and `unreachable` only
  (422 `"callbackAt" is not allowed` with confirmed/rejected; `must be greater than "now"`; `must be within 60 days`).
- The task is due again exactly then: `nextRetryAt = callbackAt` (the queue already sorts and counts by it;
  "due now" excludes it until then). Without `callbackAt` the defaults stay (postponed +24h, unreachable +4h).
- Answer/task objects (queue list, task, `order.confirmationTask`) now carry **`callbackAt`** (null when none).
  The `order.postponed` / `order.unreachable` event payload carries `callbackAt` too (for reminders/automations).

**PATCH `/workspaces/:ws/orders/:orderId/status`** `{ "status": "needs_follow_up", "followUp": "postponed", "callbackAt": "…" }`
— the same from the order page.

UI:
- Queue outcome "Postponed" (and "No answer"): a "Call back at" picker — quick chips (In 1 hour, Tonight 8 pm,
  Tomorrow 10 am, Tomorrow 5 pm) plus date + time; send in UTC ISO; show in the store's local time.
- Queue rows and the order's confirmation card: "Call back {relative time}" badge when `callbackAt` is set; highlight
  when due (`callbackAt <= now`).

Wording:
| en | ar |
|---|---|
| Call back at | يتكلم تاني الساعة |
| In 1 hour / Tonight 8 pm / Tomorrow 10 am / Tomorrow 5 pm | بعد ساعة / النهارده ٨ بالليل / بكرة ١٠ الصبح / بكرة ٥ العصر |
| Call back {time} | يتكلم تاني {time} |
| Callback due | معاد المكالمة جه |

---

## Frontend request — error messages in the reader's language — done

From `docs/ux/backend-requests.md` (U-02, U-03). Every API answer with `{ error: { code, message } }` now
returns `message` in **Arabic or French** when the request asks for it, for ~60 codes a shopper or a
signing-in merchant meets (validation, sign-in/OTP, rate limits, cart, stock, payment method, delivery area,
discount codes, minimum order, offers/upsells, refused order, uploads, unexpected error).

- Language: `X-Store-Locale` header first (the storefront already sends it), else the first `Accept-Language`
  tag (browsers send it; the dashboard can set it from the user's language). `ar` / `fr` translate; anything else
  is unchanged English.
- `code` and `details` never change. When translated, the English original is kept as `error.messageEn`
  (useful for logs/support; `VALIDATION_ERROR`'s translated message is generic — show `details` per field).
- Codes not in the list keep their English message — keep mapping the ones the UI knows.
- The list lives in `src/core/errors/errorMessages.js` (`MESSAGES`); ask for more codes in backend-requests.md.

Example (`Accept-Language: ar-EG`): `{"error":{"code":"INVALID_CREDENTIALS","message":"البريد أو كلمة المرور غير صحيحة.","messageEn":"Invalid email or password","requestId":"…"}}`

UI: send `Accept-Language` (dashboard: the user's UI language) on every API call; storefront: nothing to do
(X-Store-Locale is already sent). Show `error.message` for unmapped codes.

---

## 166. Bulk actions on funnels — UI: pending

**POST `/workspaces/:ws/funnels/bulk`**
```json
{ "action": "pause", "funnelIds": ["…", "…"], "note": "optional, publish only" }
```
- `action`: `publish` | `pause` | `resume` | `duplicate` | `delete`; `funnelIds`: 1–50 uuids (duplicates ignored).
- Permission per action, as the single buttons: publish/pause/resume → `funnels.publish` (publish and resume also
  need a live store, 402/403 from the subscription guard); duplicate/delete → `funnels.manage` (duplicate is refused
  on a restricted store and counts against the plan's funnels a month, per copy).
- Always 200 when the request is valid; each funnel is done on its own:
```json
{ "action": "duplicate", "total": 2, "succeeded": 1, "failed": 1,
  "results": [
    { "funnelId": "…", "name": "Summer offer", "ok": true, "newFunnelId": "…" },
    { "funnelId": "…", "name": "Old", "ok": false, "error": { "code": "FUNNEL_NOT_PUBLISHED", "message": "Publish this funnel before pausing or resuming it" } }
  ] }
```
  Typical per-funnel errors: `VALIDATION_ERROR` with `details` (publish: "A funnel needs at least one step"),
  `FUNNEL_NOT_PUBLISHED` (pause/resume a draft), `PLAN_LIMIT_REACHED` (duplicate), `PRODUCT_IN_FUNNEL`-style
  refusals from delete, `NOT_FOUND`.

### Dashboard — Funnels list
- Row checkboxes + "select all on this page"; a bulk bar with: Publish, Pause, Resume, Duplicate, Delete
  (Delete asks to confirm with the count). Hide buttons the user's permissions don't allow.
- After the call: toast "{succeeded} done, {failed} failed"; when some failed, a small dialog listing each failed
  funnel's name and `error.message`; refresh the list; keep failed ones selected.
- Max 50 selected (disable with a hint past that).

Wording:
| en | ar |
|---|---|
| {n} selected | {n} متحدد |
| Publish / Pause / Resume / Duplicate / Delete | نشر / إيقاف / تشغيل / نسخ / حذف |
| Delete {n} funnels? This can't be undone. | حذف {n} فانل؟ مش هتقدر ترجعهم. |
| {ok} done, {failed} failed | {ok} اتعملوا، {failed} ماتعملوش |
| These funnels were not changed | الفانلز دي ماتغيرتش |
| Up to 50 at a time | لحد ٥٠ مرة واحدة |

---

## 167. "Send Lead instead of Purchase" per store and funnel — UI: pending

An order's conversion can be reported as a **Lead** instead of a Purchase (COD stores optimising on leads).
Same moment (purchase timing), same value, same event id (browser + server still dedup), sent once.

### Store setting (permission `workspace.manage`, existing endpoint)
**GET `/workspaces/:ws/tracking-pixels/settings`** →
```json
{ "purchaseEventTiming": "on_order", "options": ["on_order", "on_confirmed", "on_delivered"],
  "conversionEvent": "purchase", "conversionEvents": ["purchase", "lead"] }
```
**PUT `/workspaces/:ws/tracking-pixels/settings`** — now any of `{ "purchaseEventTiming"?, "conversionEvent"? }` (at least one) → same shape.

### Funnel override (permission `funnels.manage`, existing endpoint)
**PATCH `/workspaces/:ws/funnels/:funnelId/settings`** `{ "conversionEvent": "lead" | "purchase" | null }`
(`null`/`""` = use the store's). Returned in `settings.conversionEvent`, also in the public funnel payload's `settings`.

### Event names per platform (browser pixels must use the same)
| kind | Meta | TikTok | Snapchat | Google (GA4) | Pinterest |
|---|---|---|---|---|---|
| purchase | `Purchase` | `CompletePayment` | `PURCHASE` | `purchase` | `checkout` |
| lead | `Lead` | `SubmitForm` | `SIGN_UP` | `generate_lead` | `lead` |
Keep value, currency, `content_ids` and the order id as event id in both cases.

### Storefront
- `GET /store/:ws` → `store.conversionEvent` (`purchase` | `lead`); a funnel's public payload `settings.conversionEvent`
  overrides it when not null. In `lib/track.ts`, where the order's Purchase fires (only with `purchaseEventTiming = on_order`),
  fire the "lead" names above instead when the effective kind is `lead`.

### Dashboard
- **Marketing → Pixels → Settings**: a radio "Report orders as: Purchase / Lead" under the existing timing choice,
  with the hint "Lead suits cash-on-delivery stores that optimise ads on orders placed."
- **Funnel → Settings → Tracking**: select "Report orders as: Store default ({current}) / Purchase / Lead".
- Pixel event log: the event name column shows `lead` for these.

Wording:
| en | ar |
|---|---|
| Report orders as | سجّل الطلبات كـ |
| Purchase / Lead | شراء (Purchase) / عميل محتمل (Lead) |
| Store default ({value}) | زي المتجر ({value}) |
| Lead suits cash-on-delivery stores that optimise ads on orders placed. | الـ Lead مناسب لمتاجر الدفع عند الاستلام اللي بتحسّن الإعلانات على الطلبات. |

---

## Frontend request — time-zone aware date range on orders — done

From `docs/ux/backend-requests.md` (U-09). Applies to **GET `/workspaces/:ws/orders`**, **`/orders/pipeline`** (tab
counts and risk counts) and **`/orders/export`** (same query), permission `orders.view`.

- `to` with a time (`2026-10-06T21:00:00.000Z`) is now an **exact exclusive instant** (send the next local midnight).
- `to` / `from` as a date (`2026-10-06`) plus **`tz`** (IANA, e.g. `Africa/Cairo`, `Asia/Riyadh`) = that whole day
  in the zone (Cairo's summer/winter clock handled). Without `tz`, a date is still the UTC day (unchanged).
- `from` with a time is used as is (unchanged).
- 422 `"tz" must be an IANA time zone, e.g. Africa/Cairo` for an unknown zone.

Either way works; the simplest for the dashboard: `from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<store or browser zone>`
for the picker and its shortcuts (Today, Yesterday, Last 7 days…).

---

## 168. Pinterest Conversions API — UI: pending

A `pinterest` tracking pixel can now send its conversions from the server too (like Meta/TikTok/Snapchat),
using the merchant's **ad account id** and **conversion access token**. Contract and modes:
`src/modules/marketing/pixelProviders/README-pinterest.md`. Default mode is **sandbox** (nothing leaves the
server) until the owner sets `PINTEREST_CAPI_MODE=live`.

### Endpoints (existing, permission `workspace.manage`)
**POST `/workspaces/:ws/tracking-pixels`** / **PATCH `/workspaces/:ws/tracking-pixels/:pixelId`**
```json
{ "platform": "pinterest", "pixelId": "2612345678901", "capiEnabled": true, "capiToken": "pina_…",
  "testEventCode": "on", "config": { "adAccountId": "549755885175" } }
```
- `config.adAccountId`: 6–20 digits; **required when `capiEnabled` is true** for Pinterest
  (422 field `config.adAccountId`: "The Pinterest ad account id is needed to turn the Conversions API on").
- `capiToken` is sealed and never returned (`capiTokenSet`, `capiTokenMask` as for other platforms).
- `testEventCode`: for Pinterest any non-empty value means "send as test events" (`?test=true`).
- `GET /tracking-pixels` → `platforms[]` now lists `{ "name": "pinterest", "capi": true, "testEventCode": true }`.
- `POST /tracking-pixels/:pixelId/test` works for Pinterest (sends a test page visit).

Events sent: order → `checkout` (or `lead`, item 167); relayed browser events → `page_visit` (page view, view content),
`add_to_cart`, `lead`. Pinterest has no checkout-start/payment-info events, so those are not sent to it.
The event id is the order id, as the browser tag's, so Pinterest dedups.

### Dashboard — Marketing → Pixels → Pinterest
- Same form as Meta's server-side section: switch "Send events from the server (Conversions API)", fields
  "Ad account id" and "Conversion access token" (password field, shows mask when set), switch "Send as test events".
- Help text linking to Pinterest Ads Manager → Conversions → "Generate access token".
- Show `lastSentAt` / `lastError` like the other platforms; the event log lists Pinterest rows.

Wording:
| en | ar |
|---|---|
| Send events from the server (Conversions API) | ابعت الأحداث من السيرفر (Conversions API) |
| Ad account id | رقم الحساب الإعلاني |
| Conversion access token | توكن التحويلات |
| Send as test events | ابعتها كأحداث تجريبية |
| The Pinterest ad account id is needed to turn the Conversions API on | محتاج رقم الحساب الإعلاني في بنترست علشان تشغّل الـ Conversions API |

---

## 169. Google Ads conversions with a conversion label — UI: pending (mostly built in item 132)

Item 132 already stores `config.adsConversionLabel` on a Google pixel and serves it to the storefront. Added now:

- **`config.adsLeadLabel`** — the label of the Ads conversion action for leads, used when the store or funnel
  reports orders as leads (item 167). Same rule as the purchase label: 4–60 of `A–Z a–z 0–9 _ -`.
- Labels are refused on a non-Ads tag: 422 field `config.adsConversionLabel` / `config.adsLeadLabel`
  "A conversion label needs a Google Ads id (AW-…)" (create, and update when the id changes).
- **`GET /store/:ws` → `store.trackingPixels[]`** for an `AW-` pixel with labels now also carries a ready **`sendTo`**:
```json
{ "platform": "google", "pixelId": "AW-123456789", "scope": { "type": "all", "ids": [] },
  "adsConversionLabel": "AbC-D_efG", "adsLeadLabel": "LeadLbl_1",
  "sendTo": { "purchase": "AW-123456789/AbC-D_efG", "lead": "AW-123456789/LeadLbl_1" } }
```

### Storefront (`lib/adPixels.ts` / `lib/track.ts`)
On the order's conversion (with `purchaseEventTiming = on_order`), for each in-scope AW- pixel:
`gtag('event', 'conversion', { send_to: sendTo[kind], value, currency, transaction_id: <order id> })`, where
`kind` is the effective conversion event (`purchase` or `lead`, item 167); skip when that key is missing.
`transaction_id` = the order id keeps a reload of the thank-you page from counting twice.

### Dashboard — Marketing → Pixels → Google (AW- id)
- Existing "Conversion label" field → rename "Purchase conversion label"; add "Lead conversion label"
  (shown only for AW- ids, like the first). Hint: "Google Ads → Goals → Conversions → your action → Tag setup →
  the part after the slash in send_to".

Wording:
| en | ar |
|---|---|
| Purchase conversion label | ليبل تحويل الشراء |
| Lead conversion label | ليبل تحويل العميل المحتمل |
| A conversion label needs a Google Ads id (AW-…) | الليبل محتاج رقم إعلانات جوجل (AW-…) |

Not built: sending Google Ads conversions from the server (offline conversion upload). It needs a Google Ads
developer token and OAuth app — the integrations team's work with the owner's account (noted in spec-gaps).

---

## 170. Google Tag Manager: a ready-made container and the dataLayer events — UI: pending

### Endpoints (permission `workspace.manage`, under the tracking-pixels router)
**GET `/workspaces/:ws/tracking-pixels/gtm/events`** — the reference list to show the merchant:
```json
{ "events": [ { "event": "view_item", "when": "A product page or a funnel product step opens" }, …,
              { "event": "purchase", "when": "…" }, { "event": "generate_lead", "when": "…" } ],
  "fields": [ { "name": "ecommerce.value", "type": "number", "note": "major units (e.g. 450.5)" }, … , { "name": "event_id", … } ] }
```
**GET `/workspaces/:ws/tracking-pixels/gtm/container[?download=true]`** — a GTM export (format v2) to import
(GTM → Admin → Import container → choose the file → Merge). Optional query: `ga4=G-…`, `ads=AW-…`,
`purchaseLabel=…`, `leadLabel=…`; without them the store's own Google pixels are used (first G- tag; first AW-
tag with its labels from item 169). `download=true` adds `Content-Disposition: attachment; filename="zimos-gtm-container.json"`.
Contents: 5 dataLayer variables, 6 Custom Event triggers (one per event), a Google tag + 6 GA4 event tags (when a
G- id is known), a conversion linker + Google Ads conversion tags for purchase/lead (when an AW- id and labels are known).
Meta/TikTok/Snapchat are deliberately left out (the store already loads them; GTM copies would double count).

### Storefront (`lib/adPixels.ts`) — small changes so the container gets everything
- Push `{ ecommerce: null }` before each ecommerce push (GA4's documented reset), then
  `{ event, event_id: dedupeId, ecommerce: { value, currency, transaction_id, items: [{ item_id }] } }`.
- When the order is reported as a lead (item 167), push `generate_lead` instead of `purchase`.

### Dashboard — Marketing → Pixels → Google Tag Manager
- On a GTM pixel: a card "Ready-made container": button "Download container" (GET …/gtm/container?download=true),
  three steps text (Download → GTM Admin → Import → Merge), and the events table from `/gtm/events`.
- If the store has no Google pixel: optional inputs GA4 id / Ads id / labels passed as query.

Wording:
| en | ar |
|---|---|
| Ready-made container | كونتينر جاهز |
| Download container | نزّل الكونتينر |
| In Google Tag Manager: Admin → Import container → choose the file → Merge. | في Google Tag Manager: الإدارة ← استيراد كونتينر ← اختار الملف ← دمج. |
| Events sent to the dataLayer | الأحداث اللي بتتبعت للـ dataLayer |
| Meta, TikTok and Snapchat stay in Zimos so nothing is counted twice. | فيسبوك وتيك توك وسناب بيفضلوا في زيموس علشان مفيش حاجة تتحسب مرتين. |

---

## 171. Live View on a world map — UI: pending

**GET `/workspaces/:ws/analytics/web/live-map?minutes=10[&funnelId=…]`** — permission `analytics.view`.
`minutes` 1–60 (default 10). Poll every 10–15 s (or on each realtime-stream tick).
```json
{ "minutes": 10, "since": "2026-10-06T18:55:09.677Z",
  "totals": { "visitors": 3, "checkouts": 1, "orders": 1 },
  "countries": [ { "country": "EG", "visitors": 2, "checkouts": 1, "orders": 1 },
                 { "country": "SA", "visitors": 1, "checkouts": 0, "orders": 0 } ],
  "places": [ { "country": "EG", "region": "Cairo", "city": null, "code": "cairo", "visitors": 1, "checkouts": 0, "orders": 1 },
              { "country": "EG", "region": "الجيزة", "city": null, "code": "giza", "visitors": 0, "checkouts": 1, "orders": 0 },
              { "country": "SA", "region": "Riyadh Region", "city": null, "code": "sa-riyadh", "visitors": 1, "checkouts": 0, "orders": 0 } ] }
```
- `country`: ISO-3166 alpha-2 (`ZZ` = unknown). Visitors are located by their session's IP lookup; checkouts by IP
  country and the governorate typed; orders by the shipping address.
- `places[].code` is the platform place code (`geo_regions`) for Egypt's governorates and Saudi regions — the same codes
  as `lib/places.ts`; null elsewhere (then `region`/`city` are the names as received). Sorted by activity, max 300.

### Dashboard — Analytics → Live (beside the realtime page)
- A world map (SVG, coloured by `countries[]` activity; no external tiles needed) with a zoomable Egypt/Saudi inset
  where `places[]` with a `code` get dots sized by activity (orders > checkouts > visitors; three colours).
- Top strip: "Visitors now", "Checking out", "Orders" from `totals`, plus the window selector (5 / 10 / 30 / 60 min)
  and the funnel filter.
- A side list of the top places. States: loading, empty ("Nobody on the store in the last {n} minutes"), error,
  no permission.

Wording:
| en | ar |
|---|---|
| Live view | المشاهدة المباشرة |
| Visitors now / Checking out / Orders | زوار دلوقتي / بيكملوا الطلب / طلبات |
| Last {n} minutes | آخر {n} دقيقة |
| Nobody on the store in the last {n} minutes | مفيش حد في المتجر آخر {n} دقيقة |
| Unknown location | مكان غير معروف |

---

## 172. Dashboard home: filter by product and by store — UI: pending

**GET `/workspaces/:ws/analytics/overview`** (permission `analytics.view`, existing) now also takes:
- `productId` — only orders with a line of that product (sales, orders, AOV, confirmation/delivery rates, series,
  top lists) and abandoned checkouts holding it. Visits/carts/checkouts can't be split by product, so they stay the
  whole store's: the answer says `"eventScope": "store"`.
- `websiteId` — one website (store) of the workspace: its orders, its visits/events, its checkouts (`eventScope: "filtered"`).
- Combinable with `funnelId`, `from`/`to`, `compare`, `currency`. 422 `unknown product` / `unknown website` when not the store's.
- With any of the three filters, net profit is the quick estimate (the full P&L has no product/site split), as with funnels.
- The answer echoes `productId`, `websiteId`, `eventScope`.
```json
{ "overview": { "funnelId": null, "productId": "db50…", "websiteId": null, "eventScope": "store",
                "metrics": { "orders": { "value": 1, "previous": 0 }, "sales": { "value": 25000, "previous": 0 } }, … } }
```

### Dashboard — Home
- Beside the funnel filter: a **Product** picker (search over `GET /catalog/products?q=`) and a **Store** picker
  (`GET /websites`; hide when the workspace has one website). Keep the choice with the remembered period (item 156).
- When `eventScope = "store"`, show a small note on the visits/conversion cards: "Visits are for the whole store".
- "Clear filters" chip.

Wording:
| en | ar |
|---|---|
| All products / All stores | كل المنتجات / كل المتاجر |
| Product / Store | المنتج / المتجر |
| Visits are for the whole store | الزيارات للمتجر كله |
| Clear filters | امسح الفلاتر |

---

## 173. A sending domain for customer emails — UI: pending

The store sends its customer emails from its own domain (`orders@mystore.com`) once DNS records are added and verified.
Contract and adapters: `src/modules/emailDomains/README.md` (sandbox by default: real DNS checks, nothing registered;
`.test`/`.example` domains always verify).

### Endpoints (permission `workspace.manage`, under the order-emails router)
**GET `/workspaces/:ws/order-emails/sending-domain`** → `{ "sendingDomain": null | {…} }`
```json
{ "sendingDomain": { "domain": "mystore.com", "localPart": "orders", "fromAddress": "orders@mystore.com",
  "status": "pending", "provider": "sandbox", "lastCheckedAt": null, "verifiedAt": null,
  "records": [
    { "purpose": "spf", "type": "TXT", "name": "mystore.com", "value": "v=spf1 include:spf.mail.zimos.example ~all" },
    { "purpose": "dkim", "type": "TXT", "name": "zimos._domainkey.mystore.com", "value": "v=DKIM1; k=rsa; p=…" },
    { "purpose": "return_path", "type": "CNAME", "name": "bounces.mystore.com", "value": "bounces.mail.zimos.example" },
    { "purpose": "dmarc", "type": "TXT", "name": "_dmarc.mystore.com", "value": "v=DMARC1; p=none" } ] } }
```
**PUT `…/sending-domain`** `{ "domain": "mystore.com", "localPart": "orders" }` — adds (or replaces) the domain → status `pending`.
422 "Enter a domain like mystore.com"; 409 `EMAIL_DOMAIN_TAKEN` when another store uses it. `localPart`: letters, digits, `.` `_` `-` (default `orders`).
**PATCH `…/sending-domain`** `{ "localPart": "shop" }` — changes the address only.
**POST `…/sending-domain/verify`** — checks DNS now; each record gets `ok: true|false`; status → `verified` when SPF, DKIM and
return-path are found (DMARC is advised only); a verified domain that later fails a check → `failed` (emails go back to the platform address).
**DELETE `…/sending-domain`** → `{ "sendingDomain": null }`.

Once `verified`, order emails and cart-recovery emails go out From `<localPart>@<domain>` with the store's sender name
(the existing sender name / Reply-To settings stay).

### Dashboard — Settings → Emails → "Sending domain"
- Empty: input "Your domain" + "Email address" (localPart + "@domain" preview) + "Add domain".
- Pending/failed: table of records (Type, Name/Host, Value with copy buttons, status tick/cross per record after a check),
  "Verify" button with last-checked time, note "DNS changes can take up to 48 hours", "Remove domain".
- Verified: green badge, "Customer emails are sent from {fromAddress}", change address, remove.

Wording:
| en | ar |
|---|---|
| Sending domain | دومين الإرسال |
| Send customer emails from your own domain | ابعت إيميلات العملاء من الدومين بتاعك |
| Add these records at your domain provider | ضيف السجلات دي عند مزوّد الدومين |
| Verify | تحقق |
| Pending / Verified / Failed | في الانتظار / متأكد / فشل |
| DNS changes can take up to 48 hours | تغييرات الـ DNS ممكن تاخد لحد ٤٨ ساعة |
| Customer emails are sent from {address} | إيميلات العملاء بتتبعت من {address} |
| Another store already sends from this domain | متجر تاني بيبعت من الدومين ده |

---

## 174. Block email designer for order emails and cart recovery — UI: pending

Any order email template (`order_confirmation`, `order_shipped`, …, `abandoned_cart`) can be built from blocks instead of
the plain body. The server renders and escapes them (no raw HTML from the merchant).

### Blocks (JSON, 1–40 per email)
| type | fields |
|---|---|
| `heading` | `text` (≤5000, `{{variables}}`), `size?`: `lg`\|`md`, `align?` |
| `text` | `text` (blank line = new paragraph), `align?` |
| `button` | `label` (≤80), `url` (https://… or a variable like `{{order_link}}`, `{{recovery_link}}`, `{{tracking_url}}`), `color?` `#RRGGBB`, `align?` |
| `image` | `url` (https), `alt?`, `link?` (https or variable), `width?` 40–600, `align?` |
| `order_table` | — (the order's lines × qty with totals, shipping and total; for cart recovery the cart's lines) |
| `divider` | — |
`align`: `start` \| `center` \| `end` (the email is RTL). Unknown fields per type → 422 (`"blocks[0].text" is not allowed`);
bad link → 422 "Use a link starting with https:// or a link variable such as order_link".

### Endpoints (existing, permission `workspace.manage`)
- **PUT `/workspaces/:ws/order-emails/:key`** — now also `{ "blocks": [...] | null }` (null/[] = back to the plain body).
  The template answer has `blocks` (null when not used); `isCustomised` is true when blocks are set.
- **POST `…/:key/preview`** and **POST `…/:key/test`** accept unsaved `blocks` too (preview uses sample lines:
  two products, shipping, total).
```json
{ "blocks": [
  { "type": "heading", "text": "شكرًا {{customer_name}}", "align": "center" },
  { "type": "text", "text": "طلبك {{order_number}} وصلنا.\n\nهنكلمك قريب." },
  { "type": "order_table" },
  { "type": "button", "label": "تابع طلبك", "url": "{{order_link}}" },
  { "type": "divider" } ] }
```
The store logo/colour header, sender name, sending domain (item 173) and the unsubscribe line (cart recovery) stay as today.

### Dashboard — Settings → Emails → (template) → "Design"
- Two modes per template: "Simple text" (today's subject + body) and "Designer" (blocks). Switching to Designer seeds
  heading + text from the current body; switching back sends `blocks: null`.
- Designer: block list with drag to reorder, add-block menu (Heading, Text, Button, Image, Order table, Divider), a side
  form per block (fields above; variable chips from `tokens`), image from the media library.
- Live preview pane (POST preview with the unsaved blocks, debounced), mobile/desktop width toggle, "Send test".

Wording:
| en | ar |
|---|---|
| Simple text / Designer | نص بسيط / مصمم |
| Add block | ضيف بلوك |
| Heading / Text / Button / Image / Order table / Divider | عنوان / نص / زرار / صورة / جدول الطلب / فاصل |
| Button link | لينك الزرار |
| Send test | ابعت تجربة |

---

## 175. Order emails per funnel or website — UI: pending

Every order-email endpoint (permission `workspace.manage`) now takes an optional **`?funnelId=`** or **`?websiteId=`**
(not both: 422). Without it you edit the store's set, exactly as before.

- **GET `/workspaces/:ws/order-emails?funnelId=…`** → `{ "scope": "funnel:<id>", "templates": [ { …template, "overridden": true|false } ], "tokens": [...] }`
  — each template as it applies to that funnel: its own version where `overridden`, else the store's.
- **PUT `/workspaces/:ws/order-emails/:key?funnelId=…`** `{ isEnabled?, subject?, body?, blocks? }` — creates/updates the funnel's
  override. A new override starts with the store's on/off; empty subject/body/blocks fall back to the store's version.
  Answer: the merged template with `"overridden": true`.
- **DELETE `/workspaces/:ws/order-emails/:key?funnelId=…`** — removes the override (the funnel uses the store's email again);
  404 when there is none; 422 without a scope.
- **POST `…/:key/preview?funnelId=…`** and **`…/:key/test?funnelId=…`** — preview / test that funnel's version.
- Unknown funnel or website → 404.

Sending: an order uses its **funnel's** override, else its **website's**, else the store's. An override switched off sends
nothing for that funnel even when the store's is on. Cart recovery reads the funnel/website from the checkout's attribution.

### Dashboard
- **Funnel → Settings → Emails** tab: the same templates list as Settings → Emails, loaded with `?funnelId=`, each row showing
  "Store default" or "Custom for this funnel"; editing saves an override; "Use store email" (DELETE) on custom rows.
- Same for a website (Website → Settings → Emails) with `?websiteId=` when the store has more than one website.

Wording:
| en | ar |
|---|---|
| Store default | زي إيميلات المتجر |
| Custom for this funnel | مخصص للفانل ده |
| Use store email | استخدم إيميل المتجر |
| Off for this funnel | مقفول للفانل ده |

---

## 176. Buy a domain in the dashboard — UI: pending

Search → buy → the store is connected with DNS set automatically → auto-renewal. Registrar is an interface with a
**sandbox** adapter (nothing is bought, no money moves); contract in `src/modules/domains/registrar/README.md`.
Prices come only from the registrar (sandbox: `DOMAIN_SANDBOX_PRICES` env), never from code; charging the merchant is
the billing team's (not here).

### Endpoints (permission `domain.manage`, under `/workspaces/:ws/domains`)
**GET `/search?q=my store`** →
```json
{ "query": "my store", "results": [
  { "domain": "my-store.com", "available": true, "price": { "amount": 55000, "currency": "EGP" }, "renewalPrice": { "amount": 55000, "currency": "EGP" } },
  { "domain": "my-store.net", "available": false, "price": null, "renewalPrice": null } ] }
```
The exact name (when the query has a TLD) plus the label on .com .net .store .shop .online .co. `price` may be null
(registrar gave none). 422 for a query without letters/digits.

**POST `/purchases`** (live store; plan's domain limit applies) `{ "domain": "my-store.com", "years": 1, "autoRenew": true, "acceptPrice": { "amount": 55000, "currency": "EGP" } }`
(`acceptPrice: null` when the price shown was null) → 201
```json
{ "purchase": { "id": "…", "hostname": "my-store.com", "status": "active", "registrar": "sandbox", "years": 1,
  "price": { "amount": 55000, "currency": "EGP" }, "autoRenew": true, "expiresAt": "2027-10-06T…", "domainId": "…" } }
```
Errors: 409 `DOMAIN_PRICE_CHANGED` (`details.price` = new quote → show and re-confirm); 409 `DOMAIN_UNAVAILABLE`;
502 `DOMAIN_PURCHASE_FAILED` ("nothing was charged"); plan-limit and draft-store errors as for connecting a domain.
The domain then appears in the normal domains list as **verified** (DNS set by us).

**GET `/purchases`** → `{ "purchases": [ … ] }` (status `pending|active|failed|expired`, `lastError`).
**PATCH `/purchases/:purchaseId`** `{ "autoRenew": false }` · **POST `/purchases/:purchaseId/renew`** `{ "years": 1-10 }` → `{ "purchase": … }`.
Daily job `domains.renew_due` renews auto-renew domains in their last 30 days.

### Dashboard — Settings → Domains → "Buy a domain"
- Search box → results list (domain, availability badge, price/year or "Price on request", Buy button).
- Buy dialog: years select (1–5), auto-renew switch, the price × years, confirm. On 409 price change: show new price, ask again.
- After purchase: success state "Your store is live on {domain}" (SSL may take a few minutes).
- "Bought domains" table: domain, expires, auto-renew switch, "Renew now", status/last error.

Wording:
| en | ar |
|---|---|
| Buy a domain | اشتري دومين |
| Search for a name | دوّر على اسم |
| Available / Taken | متاح / محجوز |
| {price} / year | {price} في السنة |
| Renews automatically | بيتجدد لوحده |
| Renew now | جدّد دلوقتي |
| The price changed — check it and confirm again | السعر اتغير — راجعه وأكّد تاني |
| Your store is live on {domain} | متجرك شغال على {domain} |

---

## 177. "Redirect to the primary domain" per domain — UI: pending

Until now every other domain of a store always sent visitors to the primary domain. Now each domain has a switch.

- **PATCH `/workspaces/:ws/domains/:domainId`** (permission `domain.manage`, existing) also takes `{ "redirectToPrimary": false }`
  (default `true` for every domain, old and new — nothing changes until a merchant turns it off).
- **GET `/workspaces/:ws/domains/overview`** — each domain has `redirectToPrimary`.
- **GET `/store/resolve-host?host=…`** (public, the storefront proxy) — for a domain with the switch off, `primaryHost` is
  `null` and `redirectToPrimary: false`, so the proxy serves the store on that domain. **The current proxy needs no change**
  (it only redirects when `primaryHost` is set and differs from the host).
- The platform subdomain (`<slug>.zimos…`) still always moves to the primary domain; the www/root counterpart setting is unchanged.

### Dashboard — Settings → Domains (each non-primary domain)
- A switch "Redirect visitors to the primary domain" (on by default), with the hint
  "Off: the store opens on this domain too (useful for a domain dedicated to a funnel)". Hidden on the primary domain.

Wording:
| en | ar |
|---|---|
| Redirect visitors to the primary domain | حوّل الزوار للدومين الأساسي |
| Off: the store opens on this domain too | لو مقفول: المتجر بيفتح على الدومين ده كمان |
