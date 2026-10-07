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

---

## 178. Webhooks: custom headers per endpoint, and new topics — UI: pending

### Custom headers (permission as today for webhooks)
**POST `/workspaces/:ws/webhooks`** and **PATCH `/workspaces/:ws/webhooks/:endpointId`** take
```json
{ "customHeaders": [ { "name": "Authorization", "value": "Bearer abc" }, { "name": "X-Api-Key", "keep": true } ] }
```
- Up to 10; `name` is an HTTP header token (≤64), `value` ≤1000 chars, no line breaks; names unique (case-insensitive).
- PATCH replaces the whole list; `{ "name": …, "keep": true }` keeps the value already stored under that name (so the UI
  never needs to know it). 422 for `keep` without a stored value.
- Not allowed (422 "… is set by Zimos and cannot be changed"): `X-Zimos-*`, `Content-Type`, `Content-Length`, `User-Agent`,
  `Host`, `Connection`, `Transfer-Encoding`, `Proxy-*` and other transport headers.
- Values are sealed and never returned: endpoints show `"customHeaders": [{ "name": "Authorization", "valueMask": "••••-123" }]`.
- Sent with every delivery and with "Send test"; Zimos' own headers always win.

### New topics (subscribe like the others; `GET /webhooks/events` lists them)
| topic | when | `data` |
|---|---|---|
| `funnel.created` | a funnel is created (also by duplicate/import) | `{ funnel: { id, name, subdomain, status } }` |
| `funnel.updated` | a funnel is saved (name, settings, status, map) | same |
| `funnel.deleted` | a funnel is deleted | `{ funnel: { id, name, subdomain, deleted: true } }` |
| `payment.paid` | a payment reaches "captured" (online, accepted transfer, COD collected) | `{ payment: { id, orderId, method, provider, status, amount, currency, paidAt }, order: {…} }` |
| `contact.updated` | a contact's name, phone, email, tags or marketing consent change | `{ contact: {…} }` |
Funnel and payment topics respect the endpoint's funnel/product filter like order topics.
Fixed on the way: `funnel.published` (and so the new funnel topics) failed to build its payload; it delivers now.

### Dashboard — Settings → Developers → Webhooks (endpoint form)
- "Custom headers" repeater: name + value (password field) rows, add/remove, max 10. Existing rows show the mask and
  "Change" (send a new value) or keep (send `keep: true`).
- Topics checklist gains the five new topics (group "Funnels", "Payments", "Contacts").

Wording:
| en | ar |
|---|---|
| Custom headers | Headers إضافية |
| Header name / Value | اسم الـ header / القيمة |
| Sent with every delivery to this endpoint | بتتبعت مع كل إرسال للعنوان ده |
| Funnel created / updated / deleted | فانل اتعمل / اتعدل / اتمسح |
| Payment received | دفعة وصلت |
| Contact updated | جهة اتصال اتعدلت |

---

## 179. An MCP server for the store (Claude, ChatGPT, any MCP client) — UI: pending

**POST `/api/public/v1/mcp`** with `Authorization: Bearer <store API key>` — MCP over HTTP (JSON-RPC 2.0, the
"Streamable HTTP" transport answered as plain JSON; GET → 405). Protocol versions 2025-06-18 / 2025-03-26 / 2024-11-05.
Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.

| tool | does | needs the key's scope |
|---|---|---|
| `list_products` `{ query?, status?, limit? }` | products with variants, prices (minor units, strings), stock | `products:read` (or `products:update`) |
| `list_orders` `{ query?, from?, to?, limit? }` | recent orders (same JSON as the public REST API) | `orders:read` / `orders:write` / `orders:update` |
| `get_order` `{ orderId? \| orderNumber? }` | one order in full | same |
| `check_pages` `{ funnelId? }` | each funnel's problems (fatal + warnings) before publishing | `funnels:read` or `funnels:write` (new) |
| `create_draft_funnel` `{ name }` | a draft funnel the merchant publishes later | `funnels:write` (new) |
The key's creator's role must also allow it (same rule as the REST API). A refusal or a store error comes back as a tool
result with `isError: true` and a readable message; a bad key is HTTP 401.

New API-key scopes: **`funnels:read`**, **`funnels:write`** (in `GET /workspaces/:ws/api-keys` → `scopes`).

Example `.mcp.json` / Claude Desktop entry the dashboard can show:
```json
{ "mcpServers": { "my-store": { "type": "http", "url": "https://api.<platform>/api/public/v1/mcp",
  "headers": { "Authorization": "Bearer <API key>" } } } }
```

### Dashboard — Settings → Developers → "AI assistants (MCP)"
- Short explanation, the server URL with a copy button, "Create a key for AI" (preset scopes: products:read, orders:read,
  funnels:read, funnels:write — editable), and copy-ready config for Claude (Desktop / Code) and ChatGPT connectors.
- The tools table above (name + what it does), and a note that funnels it creates stay drafts.

Wording:
| en | ar |
|---|---|
| AI assistants (MCP) | مساعدين الذكاء الاصطناعي (MCP) |
| Let Claude, ChatGPT or another assistant work with your store using an API key. | خلي Claude أو ChatGPT أو أي مساعد يشتغل على متجرك بمفتاح API. |
| Server URL | رابط السيرفر |
| Create a key for AI | اعمل مفتاح للذكاء الاصطناعي |
| Funnels it creates stay drafts until you publish them. | الفانلز اللي بيعملها بتفضل مسودة لحد ما تنشرها انت. |

---

## 180. Import products and reviews from AliExpress, Etsy, CJ and YouCan links — UI: pending

**POST `/workspaces/:ws/catalog/products/import`** (existing endpoint, permission `products.manage`) with `{ "url": "…" }`
now accepts product links from **AliExpress, Etsy, CJ Dropshipping and YouCan** besides Shopify. → 202
`{ "import": { "id", "kind": "aliexpress_link" | "etsy_link" | "cj_link" | "youcan_link" | "shopify_link", "status": "queued", … } }`;
poll **GET `/workspaces/:ws/catalog/imports/:importId`** as today (status `done`, `createdCount`, `errors[]`).

- The product (name, description, pictures, price, SKU) is read from the page's public structured data and created as a
  **draft with stock 0**. The page's price is kept as minor units of the **page's currency**, and the description ends with
  "(Imported price: 24.5 USD)" — the merchant checks price/currency before publishing. A missing price imports as 0.
- The **reviews the page publishes** (up to 50) are imported with `source: "import"`, **`status: "pending"`** — they show
  only after approval in Reviews. None are ever invented.
- Errors: 422 `IMPORT_SOURCE_UNREACHABLE` with the reason ("The page answered 403", "That page does not publish its product
  details; download them as a sheet and import the file instead"); 422 for a non-https link.
- `PRODUCT_IMPORT_MODE=sandbox` (server env) imports a "Sample product from X (sandbox)" with no reviews, for demos.
- Contract and the official-API adapters to add: `src/modules/catalog/importExport/importers/README.md`.

### Dashboard — Products → Import
- The "Import from a link" field's hint lists the sources (Shopify, AliExpress, Etsy, CJ, YouCan) with small logos/badges
  detected from the pasted link.
- After the import: "Imported as a draft — check the price ({currency}) and stock", and "{n} reviews waiting for approval"
  linking to Reviews filtered to pending + source import.
- Reviews list: a source badge "Imported" for `source = "import"`.

Wording:
| en | ar |
|---|---|
| Import from a link (Shopify, AliExpress, Etsy, CJ, YouCan) | استورد من لينك (شوبيفاي، علي إكسبريس، إتسي، CJ، يوكان) |
| Imported as a draft — check the price and stock | اتضاف كمسودة — راجع السعر والمخزون |
| {n} reviews waiting for your approval | {n} تقييم مستني موافقتك |
| Imported | مستورد |
| That page does not publish its product details | الصفحة دي مش بتعرض بيانات المنتج |

## 181. Send orders to a Shopify or WooCommerce store, and bring back fulfilment — UI: pending

Two new providers on the **existing dropship screens** (Apps → Dropshipping; permission `apps.manage`; order page Supplier
card: `orders.view` / `orders.manage`). No new endpoint: the existing ones take `code` = `shopify` or `woocommerce`.

**GET `/workspaces/:ws/dropship/providers`** now lists them (also in production):
```json
{ "providers": [
  { "code": "shopify", "name": "Shopify store", "isTest": false, "connected": false, "accountName": null, "followsStatus": true,
    "credentialFields": [
      { "key": "storeUrl", "label": { "en": "Store address (mystore.myshopify.com)", "ar": "عنوان المتجر (mystore.myshopify.com)" }, "secret": false, "required": true },
      { "key": "accessToken", "label": { "en": "Admin API access token", "ar": "توكن Admin API" }, "secret": true, "required": true } ] },
  { "code": "woocommerce", "name": "WooCommerce store", "credentialFields": [ "storeUrl", "consumerKey (secret)", "consumerSecret (secret)" ], "…": "…" }
] }
```

- **PUT `/dropship/providers/shopify`** `{ "credentials": { "storeUrl": "mystore.myshopify.com", "accessToken": "shpat_…" } }`
  → `{ "code": "shopify", "connected": true, "accountName": "My Shop" }`. The address may omit `https://`; it must be https.
  Errors 422 `DROPSHIP_INVALID_CREDENTIALS` ("The store refused the credentials", "The store address must start with https://").
  Secrets are sealed and never returned.
- **PUT `/dropship/providers/woocommerce`** `{ "credentials": { "storeUrl": "https://mystore.com", "consumerKey": "ck_…", "consumerSecret": "cs_…" } }`.
- **POST `/dropship/providers/:code/import`** `{ "code": "123456" }` (the product id in that store) → 201 `{ product }`, a draft.
  Variant SKUs become the other store's ids (Shopify variant id; Woo `30` or `30:31`) — **the UI should warn not to edit
  these SKUs**, they link the lines. 404 `DROPSHIP_PRODUCT_NOT_FOUND`, 409 `DROPSHIP_ALREADY_IMPORTED`.
- **POST `/dropship/providers/:code/orders/:orderId/push`** (or the order page's `/orders/:orderId/dropship/:code/push`)
  → `{ "externalOrderId": "5000", "externalStatus": "open", "suggestedStage": null }`. Pushing again returns the same order.
  WooCommerce refuses an order with a line that is not one of its products: 409 `DROPSHIP_ORDER_REJECTED`
  ("\"Demo T-Shirt\" is not a product of the WooCommerce store"). Shopify sends such a line as a custom line.
- **POST `/orders/:orderId/dropship/refresh`** and the follow job bring the status back: Shopify `open|partial|fulfilled|delivered|cancelled`,
  Woo `pending|processing|on-hold|completed|cancelled|refunded|failed`; `suggestedStage` = shipped / delivered / cancelled /
  returned, applied by itself when the provider's "apply status" setting is on (existing PATCH `/providers/:code/settings`).

### Screens
- Dropshipping page: two cards "Shopify store" and "WooCommerce store" in a group **"Your other store"** (separate from the
  suppliers), with the credential form generated from `credentialFields` and a help link on where to get the token/keys.
- Import dialog: field "Product id in your store".
- Order page Supplier card: unchanged; shows the provider name, its order number and status.

Wording:
| en | ar |
|---|---|
| Your other store | متجرك التاني |
| Send orders to your Shopify or WooCommerce store and get the shipping status back | ابعت الأوردرات لمتجرك على شوبيفاي أو ووكومرس وارجع بحالة الشحن |
| Product id in your store | رقم المنتج في متجرك |
| Don't change these SKUs: they link the product to your store | متغيرش الـ SKU دي: هي اللي بتربط المنتج بمتجرك |
| Sent to your store as order #{id} | اتبعت لمتجرك كأوردر رقم {id} |
| This product isn't in your WooCommerce store | المنتج ده مش موجود في متجر ووكومرس بتاعك |

## 182. Send contacts to Mailchimp or Klaviyo — UI: pending

App-store apps **Mailchimp** and **Klaviyo** (`/apps`, now "available", not "coming soon"; open path `/apps/email-marketing`).
They must be installed (POST `/workspaces/:ws/apps/:key/install`) before connecting, or 403 `APP_NOT_INSTALLED`.
A test provider `sandbox` ("Test email list", `isTest: true`) exists outside production and needs no install.
All routes: `/workspaces/:ws/email-marketing/...`, permission **`apps.manage`**.

Only contacts **with an email, who agreed to marketing (`marketingConsent`) and are not blocked** are ever sent. A contact who
withdraws consent is unsubscribed there. New or changed contacts (checkout, forms, funnel opt-ins, newsletter, added by hand,
edited) go by themselves within seconds; "Sync now" sends everyone already in the store (up to 20,000 per run).

**GET `/providers`** →
```json
{ "providers": [ { "code": "mailchimp", "name": "Mailchimp", "isTest": false,
  "credentialFields": [ { "key": "apiKey", "label": { "en": "API key", "ar": "مفتاح API" }, "secret": true, "required": true } ],
  "connected": true, "accountName": "My Brand", "listId": "ab12cd", "listName": "Newsletter",
  "tags": ["zimos"], "sources": ["leads", "buyers"], "lastSyncAt": "2026-10-06T19:55:44.023Z", "syncedCount": 120,
  "syncing": false, "lastError": null } ] }
```
- **PUT `/providers/:code`** `{ "credentials": { "apiKey": "…-us21" } }` → the provider view. Key 6–200 chars. 422
  `EMAIL_MARKETING_INVALID_CREDENTIALS` ("The service refused the API key"; Mailchimp: "A Mailchimp API key ends in its data centre,
  like \"-us21\""). Reconnecting keeps the list and tags. The key is never returned.
- **DELETE `/providers/:code`** → `{ "code", "connected": false }`.
- **GET `/providers/:code/lists`** → `{ "lists": [ { "id": "ab12cd", "name": "Newsletter", "memberCount": 5 } ] }` (Klaviyo: `memberCount: null`).
  409 `EMAIL_MARKETING_NOT_CONNECTED`.
- **PATCH `/providers/:code/settings`** `{ "listId"?, "tags"?: [≤10 × ≤60 chars], "sources"?: ["leads"|"buyers", 1–2] }` (at least one)
  → the provider view. A list not in the account: 404 `EMAIL_MARKETING_LIST_NOT_FOUND`. `leads` = contacts with no order yet,
  `buyers` = contacts with an order. Mailchimp tags = these tags + the contact's own tags; Klaviyo gets them as the profile
  property `zimos_tags`.
- **POST `/providers/:code/sync`** → 202 `{ "queued": true }`; `syncing` turns true until done, then `lastSyncAt`, `syncedCount`.
  409 `EMAIL_MARKETING_NO_LIST` before a list is picked.
- `lastError` (string|null): the last refusal (key revoked, list deleted…), cleared on the next success.

### Screen — Apps → Email marketing (`/apps/email-marketing`)
- One card per provider: logo, name, "Test" badge for `isTest`, status (Not connected / Connected as {accountName}).
- Not connected: the key field from `credentialFields` (password input) + "Connect"; for Mailchimp a help line on where to find the key.
- Connected: list picker (GET lists), tags input (chips), checkboxes "Leads (no order yet)" / "Buyers", "Save";
  "Sync now" with "Last synced {time} — {n} contacts" or a spinner while `syncing`; red banner with `lastError`; "Disconnect".
- Note under the card: "Only contacts who agreed to marketing are sent."

Wording:
| en | ar |
|---|---|
| Email marketing | التسويق بالإيميل |
| Send contacts who agreed to marketing to your list | ابعت العملاء اللي وافقوا على التسويق لقائمتك |
| API key | مفتاح API |
| Connected as {name} | متوصل باسم {name} |
| List | القائمة |
| Tags added to each contact | تاجات تتحط على كل عميل |
| Leads (no order yet) | عملاء محتملين (لسه ماطلبوش) |
| Buyers | اللي اشتروا |
| Sync now | زامن دلوقتي |
| Last synced {time} — {n} contacts | آخر مزامنة {time} — {n} عميل |
| Only contacts who agreed to marketing are sent. | بنبعت بس العملاء اللي وافقوا على التسويق. |
| Pick a list first | اختار قائمة الأول |

## 183. Express checkout buttons (Apple Pay, Google Pay, PayPal), Stripe and PayPal — UI: pending

Two new gateways on the **existing Payments screen** (`/workspaces/:ws/payments/gateways`, permission `workspace.manage`); the
connect form is rendered from the adapter's fields as for Paymob/Kashier — **no new endpoint**.

**PUT `/workspaces/:ws/payments/gateways/stripe`**
`{ "credentials": { "secretKey": "sk_live_…", "webhookSecret": "whsec_…" }, "settings": { "expressWallets": true } }`
- `secretKey` must start `sk_test_`/`sk_live_` (or `rk_`) — 422 "A Stripe secret key starts with sk_test_ or sk_live_";
  refused key → 422 `GATEWAY_AUTH_FAILED`. Mode comes from the key (sk_test_ = test, shown only in the store preview).
- `webhookSecret` optional (whsec_…). Show the account's `webhookUrl` with "add it in Stripe → Developers → Webhooks for
  the checkout.session events". Without it, payments are still confirmed when the shopper comes back.
- Setting `expressWallets` (boolean, default true): "Show Apple Pay and Google Pay buttons".

**PUT `/workspaces/:ws/payments/gateways/paypal`** `{ "credentials": { "clientId": "…", "clientSecret": "…" } }`
- Sandbox or live is detected (the account's `mode` is `test` for sandbox keys). Currencies: USD, EUR, GBP, CAD, AUD only.

**New payment method `paypal`** (orders.payment_method; order lists/exports/invoices show "PayPal" / "باي بال"). Filters and
badges that list methods should add it.

### Storefront — express buttons
**GET `/store/:ws/payment-methods?currency=USD`** — methods may now carry `express`:
```json
{ "methods": [
  { "id": "cod", "provider": null, "method": "cod", "mode": "live" },
  { "id": "stripe:card", "provider": "stripe", "method": "card", "mode": "live", "express": { "wallets": ["apple_pay", "google_pay"] } },
  { "id": "paypal:paypal", "provider": "paypal", "method": "paypal", "mode": "live", "express": { "wallets": ["paypal"] } }
], "currency": "USD" }
```
- At the **top of checkout**, for each method with `express`, show its buttons: "Apple Pay" (only where
  `window.ApplePaySession` exists), "Google Pay", "PayPal" (yellow PayPal button). Below: "Or pay another way".
- A button submits the normal checkout (same contact/address fields, validated first) with
  `paymentMethod` = the method (`card` for Apple/Google Pay, `paypal` for PayPal), `paymentProvider` = its provider and
  `returnUrl`; then redirect to `payment.redirectUrl` exactly as for card today. Stripe's page shows Apple Pay /
  Google Pay on capable devices; PayPal's page asks the shopper to approve.
- Coming back: call the existing `POST /store/:ws/orders/:orderId/payment/return` (the payment is confirmed by asking the
  gateway; status `paid`). PayPal is collected at that moment.
- PayPal is not offered for EGP/SAR/AED/MAD orders (the list already leaves it out).
- The sandbox gateway offers `card` and `paypal` with `express` too, to try in the store preview.

### Dashboard
- Payments → connect cards "Stripe" and "PayPal" (logos), with setup steps and help links from the adapter.
- Payment methods list: show the wallet badges from `express` next to "Card (Stripe)" and "PayPal".

Wording:
| en | ar |
|---|---|
| Express checkout | دفع سريع |
| Or pay another way | أو ادفع بطريقة تانية |
| Pay with PayPal | ادفع بـ PayPal |
| Show Apple Pay and Google Pay buttons | اعرض أزرار Apple Pay وGoogle Pay |
| PayPal | باي بال |
| PayPal isn't available in this currency | PayPal مش متاح بالعملة دي |

## 184. Address autocomplete at checkout — UI: pending

### Storefront (public, no auth; storefront rate limit)
- **GET `/store/:ws/address/config`** → `{ "enabled": true, "provider": "builtin" | "google" | null, "attribution": "google" | null }`
  (cached 60 s). Show the autocomplete only when `enabled`; with `attribution: "google"` show "Powered by Google" under the list.
- **GET `/store/:ws/address/suggest?q=…&country=EG&lang=ar&session=…`** — `q` 2–120 chars (send after 2 chars, debounce ~250 ms);
  `country` optional (store's country); `lang` ar|en|fr; `session` optional, 8–64 chars `[A-Za-z0-9_-]` — generate one per
  checkout visit and reuse it for suggest and details (groups Google billing).
  → `{ "enabled": true, "suggestions": [ { "id": "p:52bf…", "text": "الحي العاشر", "secondaryText": "مدينة نصر، القاهرة", "level": "area" } ] }`
  (at most 8; `level`: region|city|area|address). Off → `{ "enabled": false, "suggestions": [] }`.
- **GET `/store/:ws/address/details?id=…&session=…`** →
```json
{ "address": { "country": "EG", "province": "القاهرة", "city": "مدينة نصر", "area": "الحي العاشر",
  "addressLine": "12 Abbas El Akkad", "postalCode": null, "placeId": "52bf…", "location": { "lat": 30.05, "lng": 31.34 } } }
```
  Fill the checkout fields with the non-null values: province/city/area pickers (names are the store list's names, so they
  select the right entries), `placeId` → the address `placeId` (delivery price), `addressLine` → street field (Google only;
  the store list gives no street, so focus the street field next). 404 `ADDRESS_NOT_FOUND`.

### Checkout UI
- One field "Search your address" above the address fields (or the area field), dropdown of suggestions: `text` bold,
  `secondaryText` grey; keyboard up/down/enter; "No matches — fill the address below" when empty. Manual entry always stays possible.

### Dashboard — Settings → Shipping → Places (permission `shipping.manage`)
- **GET `/workspaces/:ws/address-autocomplete`** →
  `{ "provider": "builtin", "providers": [ { "code": "builtin", "name": { "en": "Your places list", "ar": "قائمة أماكنك" }, "needsKey": false }, { "code": "google", "name": { "en": "Google Maps", "ar": "خرائط جوجل" }, "needsKey": true } ], "hasKey": false, "lastError": null }`
- **PUT** same path `{ "provider": "off" | "builtin" | "google", "apiKey"?: "AIza…" (20–200) }` → same shape.
  Google without a key: 422 `ADDRESS_LOOKUP_KEY_REQUIRED`; a refused key: 422 `ADDRESS_LOOKUP_INVALID_KEY` ("is the Places API
  enabled for it?"). The key is never returned (`hasKey` only). `lastError` shows when Google later refuses the key — shoppers
  then get suggestions from the places list meanwhile.
- Card "Address suggestions at checkout": radio Off / Your places list / Google Maps; key field (password) when Google;
  note "Google bills your Google Cloud account for these lookups."

Wording:
| en | ar |
|---|---|
| Search your address | دوّر على عنوانك |
| No matches — fill the address below | مفيش نتايج — اكتب العنوان تحت |
| Powered by Google | Powered by Google |
| Address suggestions at checkout | اقتراحات العنوان في صفحة الدفع |
| Your places list | قائمة أماكنك |
| Google Maps | خرائط جوجل |
| Google API key | مفتاح Google API |
| Google bills your Google Cloud account for these lookups. | جوجل بتحاسب حساب Google Cloud بتاعك على عمليات البحث دي. |

## 185. Shopper accounts: sign in with a code, orders, saved addresses, reorder — UI: pending

### Dashboard — Store settings → Customer accounts (permission `website.edit`)
- **GET `/workspaces/:ws/shopper-accounts`** → `{ "enabled": false, "channels": ["sms"] }`
- **PUT** same `{ "enabled": true, "channels": ["sms", "email"] }` (channels: sms|email, at least one, unique) → same shape.
- Card: switch "Let customers sign in to see their orders"; checkboxes "Phone (SMS code)" / "Email code".
  Note: "SMS codes are sent through your SMS provider."

### Storefront — all under `/store/:ws/account`, token in header **`X-Shopper-Token`**
- **GET `/config`** → `{ "enabled": true, "channels": ["sms","email"] }`. Hide every account link when `enabled` is false
  (all other routes then answer 404 `SHOPPER_ACCOUNTS_OFF`).
- **POST `/code`** `{ "phone": "010…" }` or `{ "email": "…" }` (exactly one) + optional `"locale": "ar"|"en"` →
  `{ "sent": true, "channel": "sms", "target": "01******003", "expiresInSeconds": 600, "resendAfterSeconds": 60 }`.
  Same answer whether the address is known or not (an unknown email simply gets no code). Errors: 429 `TOO_MANY_CODES`
  `details.retryAfterSeconds` (60 s between codes, 5/hour, 10/day per address, 20/hour per IP); 422 `INVALID_PHONE`;
  422 `SHOPPER_CHANNEL_OFF` ("Sign in with your phone/email").
- **POST `/verify`** `{ "phone"|"email", "code": "123456" }` →
  `{ "token": "…", "expiresInSeconds": 2592000, "customer": { "id", "fullName", "phone", "email", "marketingConsent", "ordersCount" }, "addresses": [...] }`.
  Errors 422 `INVALID_CODE` (`details.attemptsLeft`), 422 `CODE_EXPIRED`, 429 `TOO_MANY_ATTEMPTS` (5 wrong → ask again).
  A phone that never ordered becomes a contact on first sign-in. Keep the token (30 days) in localStorage; any 401
  `SHOPPER_NOT_SIGNED_IN` → drop it and show sign in.
- **GET `/me`** → `{ customer, addresses }`. **PATCH `/me`** `{ fullName?, email?, marketingConsent? }` → same.
- **POST `/sign-out-everywhere`** → `{ "signedOut": true }` (all devices). Plain "Sign out" = forget the token locally.
- **GET `/orders?before=<ISO date>`** → `{ "orders": [ { "id", "orderNumber", "createdAt", "stage": 0, "totalAmount": "50000", "currency": "EGP", "itemsCount": 2, "firstItemName": "Demo T-Shirt" } ], "nextBefore": null }`
  (20 per page; `stage` as the tracking page: 0 placed, 1 confirmed, 2 shipped, 3 delivered).
- **GET `/orders/:orderId`** → `{ "order": { "id", "createdAt", "paymentMethod", "shippingAddress", …everything the tracking page shows (stage, steps, items, amounts, courier, waybill, downloads, notes) } }`.
- **POST `/orders/:orderId/reorder`** →
  `{ "lines": [ { "variantId", "productId", "name", "quantity": 2, "unitPrice": "25000", "available": true, "reason": null } ] }`
  `reason`: null | `low_stock` (quantity lowered to what is left) | `out_of_stock` | `unavailable`. Put the available lines in the
  cart and open it; list the others as "No longer available".
- **Addresses**: **GET `/addresses`**; **POST `/addresses`** `{ label?, fullName?, phone?, country (2 letters, required), province?, city (required), area?, addressLine (required), postalCode?, placeId?, isDefault? }` → 201 `{ addresses }`;
  **PATCH `/addresses/:id`** (any field) → `{ addresses }`; **DELETE `/addresses/:id`** → `{ addresses }`. Max 10 (422
  `TOO_MANY_ADDRESSES`); exactly one `isDefault`.

### Storefront screens
- Header: "Sign in" / account icon when `enabled`.
- Sign in: phone (or email tab when allowed) → "Send code" → 6-digit code input with resend countdown → signed in.
- Account: tabs "My orders" (list → order page with the tracking timeline and "Order again"), "Addresses" (list, add/edit form,
  set default, delete), "Profile" (name, email, marketing checkbox, "Sign out", "Sign out of all devices").
- Checkout when signed in: prefill contact from `/me`, address picker of saved addresses (default selected), "Save this address".

Wording:
| en | ar |
|---|---|
| Sign in | تسجيل الدخول |
| We'll send you a code | هنبعتلك كود |
| Send code | ابعت الكود |
| Enter the 6-digit code sent to {target} | اكتب الكود اللي اتبعت على {target} |
| Resend in {s}s | إعادة الإرسال بعد {s} ث |
| My orders | طلباتي |
| Order again | اطلب تاني |
| No longer available | مبقاش متاح |
| Addresses | العناوين |
| Default | الافتراضي |
| Sign out of all devices | الخروج من كل الأجهزة |
| Let customers sign in to see their orders | خلّي العملاء يدخلوا يشوفوا طلباتهم |

## Frontend requests (2026-10-06, docs/ux/backend-requests.md) — done

### Domain purchase order of checks (money) — done
`POST /workspaces/:ws/domains/purchases` now checks **before** registering: not a platform subdomain (422), store set up with a
website and a slug (409 `STORE_NOT_SET_UP`), the www/root not connected to another store (409 `DOMAIN_UNAVAILABLE`), plan
limit, availability, price (409 `DOMAIN_PRICE_CHANGED`). Nothing is registered when any fails. If something fails *after*
the registrar registered it: 502 **`DOMAIN_CONNECT_FAILED`** "The domain was bought but could not be connected yet — support
will finish it" (the purchase shows `status: "failed"` with `lastError`); `DOMAIN_PURCHASE_FAILED` ("nothing was charged")
is only for failures before that. Suggested UI: on `DOMAIN_CONNECT_FAILED` show a warning (not "nothing charged").

### Root domain purchase and www — done
Buying a root domain now creates the **www record too** (CNAME/ALIAS to the store, purpose `redirect`) with the others, and
the domain's `counterpart` carries **`dnsManaged: true`** (GET `/domains/overview` → `domains[].counterpart.dnsManaged`).
UI: when `counterpart.dnsManaged` is true, don't ask the merchant to add the www record ("We set this up for you" /
"جهزناه لك").

### Renewal price quote — done
- **GET `/workspaces/:ws/domains/purchases/:purchaseId/renew-quote?years=1`** (domain.manage; years 1–10) →
  `{ "hostname": "mystore.com", "years": 2, "price": { "amount": 110000, "currency": "EGP" } | null, "expiresAt": "2029-10-06T…" }`
  (`expiresAt` = the new expiry). 409 `DOMAIN_NOT_ACTIVE` for a purchase that isn't active/expired.
- **POST `/purchases/:purchaseId/renew`** now takes optional **`acceptPrice`** (`{ amount, currency }` or null, as shown by the
  quote); a different current price → 409 `DOMAIN_PRICE_CHANGED` with `details.price`. Without `acceptPrice` it behaves as before.
- Renew dialog: years select → quote → "Renew for {price} until {date}" → confirm with `acceptPrice`.

### Funnel/website email override in simple text — done
On an override (`?funnelId=` / `?websiteId=`), **`PUT /order-emails/:key` with `"blocks": null`** now means "this override
uses its own plain subject + body": it is stored as such and the store's blocks no longer come back (preview, test and real
sends). An override that never sends `blocks` still inherits the store's blocks. On the store itself `blocks: null` is
unchanged (plain body). Lists/GET show `blocks: null` for a plain override with `overridden: true`. UI: the "Plain text"
toggle on a funnel/website email sends `blocks: null`.

## 186. Shopper returns from the tracking page (and the account) — UI: pending

### Dashboard — Orders → Returns settings (permission `orders.manage`)
- **GET `/workspaces/:ws/shopper-returns`** → `{ "enabled": false, "windowDays": 14, "photoRequiredFor": ["damaged", "defective"] }`
- **PUT** same `{ "enabled": true, "windowDays": 7 (1–365), "photoRequiredFor": [reason codes] }` → same shape.
- Card "Let customers ask for a return": switch, "Days after delivery" number, checkboxes "Photo required for" per reason.
- Returns list/order page (existing `GET /workspaces/:ws/returns`, `GET /orders/:id/returns`): each return now has
  **`source`** (`merchant` | `shopper`) and **`photos`** `[{ uploadId, url, expiresAt }]` (signed links). Show a "From customer"
  badge and the photo thumbnails; approve/reject/restock as today. A new shopper return records the event `return.requested`.

### Storefront — `/store/:ws/returns` (public)
The order is named either by the tracking page's token (`token`, the `t` of the tracking link) or, for a signed-in shopper,
by `orderId` + header `X-Shopper-Token` (item 185).
- **GET `/eligibility?token=…`** (or `?orderId=…`) →
```json
{ "eligible": true, "reason": null, "deadline": "2026-10-13T20:23:57Z", "windowDays": 7,
  "reasons": ["damaged","defective","wrong_item","not_as_described","no_longer_wanted","arrived_late","other"],
  "photoRequiredFor": ["damaged","defective"],
  "items": [ { "orderItemId": "…", "name": "Demo T-Shirt", "variantOptions": { "Size": "M" }, "quantity": 3, "returnable": 3 } ],
  "returns": [ { "id", "status": "requested", "reason": "damaged: cracked", "items": [...], "source": "shopper", "createdAt" } ] }
```
  `reason` when not eligible: `off` (hide the button), `cancelled`, `not_delivered`, `window_closed`, `already_requested`.
  404 for an unknown token/order; 401 `SHOPPER_NOT_SIGNED_IN` for a bad shopper token.
- **POST `/`** `{ "token"|"orderId", "reasonCode", "reasonDetail"? (≤280), "items": [ { "orderItemId", "quantity" } ] (1–50, unique), "photoUploadIds"? [≤4] }`
  → 201 `{ "return": { "id", "status": "requested", "reason", "items", "source": "shopper", "createdAt" } }`.
  Photos: upload first with the existing `POST /store/:ws/uploads` (multipart `file`, header `X-Visitor-Id`), send the
  `upload.uploadId`s here **with the same `X-Visitor-Id`**. Errors: 409 `RETURN_NOT_POSSIBLE` (`details.reason` as above);
  422 with `items.N.quantity` "At most N can be returned", `photoUploadIds` "Add a photo of the problem" / "A photo is
  missing or has expired — upload it again".

### Storefront screens
- Tracking page (and account order page): "Return items" button when `eligible`, with "until {deadline}"; past returns listed
  with their status (Requested / Approved / Rejected / Received / Refunded).
- Return form: lines with quantity steppers up to `returnable`, reason select, details textarea, photo picker (required when
  the reason is in `photoRequiredFor`), "Send request" → "We got your request — the store will contact you".

Wording:
| en | ar |
|---|---|
| Return items | ارجع منتجات |
| Returns possible until {date} | المرتجع متاح لحد {date} |
| Why are you returning it? | ليه عايز ترجعه؟ |
| Damaged / Defective / Wrong item / Not as described / No longer wanted / Arrived late / Other | وصل متكسر / فيه عيب / منتج غلط / مش زي الوصف / مبقتش عايزه / وصل متأخر / سبب تاني |
| Add a photo of the problem | ضيف صورة للمشكلة |
| Send request | ابعت الطلب |
| We got your request — the store will contact you | وصلنا طلبك — المتجر هيتواصل معاك |
| Returns are closed for this order | المرتجع اتقفل للطلب ده |
| From customer | من العميل |
| Let customers ask for a return | خلّي العملاء يطلبوا مرتجع |
| Days after delivery | عدد الأيام بعد الاستلام |

## 187. Import contacts from CSV / Excel, with tags and marketing consent — UI: pending

Permission `customers.manage`.
- **GET `/workspaces/:ws/contacts/import/template`** → a CSV file (UTF-8 with BOM): `phone,name,email,tags,marketing_consent`
  and one example row. Link "Download the template".
- **POST `/workspaces/:ws/contacts/import`** — multipart: `file` (.csv or .xlsx, ≤5MB, ≤5000 rows), `mode` = `update` (default:
  a phone already in the store gets the sheet's name/email/consent and the tags added) | `skip` (left alone), `tags` (optional,
  comma-separated, added to every imported contact, e.g. "imported-oct"), `dryRun` = `true` to check without saving.
  →
```json
{ "total": 5, "created": 3, "updated": 0, "skipped": 0, "unchanged": 0, "invalid": 1, "dryRun": true,
  "columns": { "phone": "الموبايل", "fullName": "الاسم", "email": "البريد", "tags": "التاجات", "consent": "موافقة_التسويق" },
  "errors": [ { "row": 4, "field": "phone", "message": "\"not-a-phone\" is not a phone number" },
              { "row": 3, "field": "email", "message": "\"bad-email\" is not an email (the row is imported without it)" } ],
  "moreErrors": 0 }
```
  Columns are matched by name, English or Arabic: phone (phone, mobile, الموبايل, الهاتف…, **required**), name (name, full_name,
  الاسم), email (email, البريد, الإيميل), tags (tags, التاجات — separated by `,` `;` `|` `،`), marketing consent
  (marketing_consent, accepts_marketing, consent, موافقة_التسويق — yes/no, نعم/لا, true/false, 1/0). `columns` shows which column
  was used for each field (null = not found). Only `field: "phone"` errors skip the row; other errors import the row without
  that value. The same phone twice: one contact, later values win, tags add up.
  422 `INVALID_FILE` (no phone column / unreadable), 413 `FILE_TOO_LARGE`, 422 `NO_FILE`.
- **Marketing consent is never turned on for everyone**: only a row saying yes turns it on (no means off, empty leaves it).
  New contacts get `source: "import"`, and sync to email lists (182) and webhooks like any new contact.

### Screen — Contacts → Import
1. Upload the file, choose "Update existing contacts" / "Skip existing contacts", optional "Add these tags", then
   "Check file" (dryRun) → summary: "{created} new, {updated} updated, {skipped} skipped, {invalid} rows without a valid phone"
   with the matched columns and the errors table (row, field, message).
2. "Import" (same file, dryRun false) → same summary as done.
- A note: "Only mark marketing consent yes for people who agreed to receive your offers."

Wording:
| en | ar |
|---|---|
| Import contacts | استيراد العملاء |
| Download the template | نزّل النموذج |
| Update existing contacts | حدّث العملاء الموجودين |
| Skip existing contacts | سيب العملاء الموجودين زي ما هم |
| Add these tags to everyone | ضيف التاجات دي للكل |
| Check file | راجع الملف |
| {n} new, {m} updated, {s} skipped | {n} جديد، {m} اتحدّث، {s} اتساب |
| {i} rows without a valid phone | {i} صف من غير رقم صحيح |
| Only mark marketing consent yes for people who agreed to receive your offers. | علّم موافقة التسويق بـ"نعم" بس للناس اللي وافقوا يستقبلوا عروضك. |

## 188. Wishlist for signed-in shoppers — UI: pending

Works when the store has shopper accounts on (185); otherwise 404 `SHOPPER_ACCOUNTS_OFF`. Header `X-Shopper-Token` (401
`SHOPPER_NOT_SIGNED_IN` without a valid one).
- **GET `/store/:ws/account/wishlist`** →
```json
{ "items": [ { "id": "d5da…", "productId": "db50…", "variantId": null, "addedAt": "2026-10-06T20:30:12Z",
  "product": { "name": "Demo T-Shirt", "slug": "demo-t-shirt", "imageUrl": null },
  "price": { "amount": "25000", "compareAt": null, "currency": "EGP" }, "available": true } ], "count": 1 }
```
  Newest first. `available: false` = archived, out of stock or no longer for sale (keep showing it greyed, "Unavailable").
- **POST `/store/:ws/account/wishlist`** `{ "productId", "variantId"? }` → 201 + the list. Adding the same product (and
  variant) again is a no-op. 404 for a product not for sale; 422 `WISHLIST_FULL` (200 items).
- **DELETE `/store/:ws/account/wishlist/:itemId`** → the list (404 if not theirs).
- **POST `/store/:ws/account/wishlist/merge`** `{ "items": [ { "productId", "variantId"? } ] }` → the list. For guests:
  keep hearts in localStorage, send them here right after sign-in, then clear them; products no longer for sale are ignored.
- Merchant: **GET `/workspaces/:ws/wishlists/top?limit=20`** (products.view) →
  `{ "products": [ { "productId", "name", "slug", "status", "shoppers": 12, "lastAddedAt" } ] }`.

### Screens
- Storefront: heart button on product cards and the product page (filled when on the list; a guest's tap fills it locally
  and offers "Sign in to keep your wishlist"); account tab "Wishlist" with add-to-cart and remove.
- Dashboard: Products → a "Most wished" card/list (product, shoppers count).

Wording:
| en | ar |
|---|---|
| Wishlist | المفضلة |
| Add to wishlist | ضيف للمفضلة |
| Remove from wishlist | شيل من المفضلة |
| Sign in to keep your wishlist | سجّل دخول عشان تحفظ مفضلتك |
| Unavailable | مش متاح |
| Most wished | الأكتر في المفضلة |
| {n} shoppers | {n} عميل |

### Shipping quote `configured` with only place prices — done
`POST /store/:ws/shipping-quote` → `quote.configured` is now **true** when any visible place of the store's own list
(regions/cities/areas, item 163/164) has a price, even with no governorate rates, default rate, free threshold or zones.
Before an address is picked such a store answers `rule: "no_rate"`, `amount: 0`, `configured: true` → the storefront can show
"Calculated once you pick your area" / «بيتحسب بعد ما تختار منطقتك».

### Cart quote with "<ar> (<en>)" governorate — done
The place-name matching (`placePricing.placesOf`, used by the quote and checkout when no `placeId` is sent) now accepts the
storefront's "القاهرة (Cairo)" spelling (either half matches), the plain Arabic or English name, and the region/city's
platform code (`geoCode`, e.g. "cairo"). Verified: a Cairo region price of 65.00 applies to "القاهرة (Cairo)", "القاهرة",
"Cairo" and "cairo".

## 189. Gift cards: issue, sell as a product, redeem at checkout, check the balance — UI: pending

### Dashboard — Marketing → Gift cards (permission `discounts.manage`), `/workspaces/:ws/gift-cards`
- **GET `/?state=active|empty|expired|disabled&q=…&before=…&limit=50`** → `{ "giftCards": [ view ], "nextBefore": null }`;
  `q` = a full code, its last 4, or part of the recipient's email. A view:
```json
{ "id": "fe86…", "last4": "T6FK", "initialAmount": "50000", "balanceAmount": "25000", "currency": "EGP", "state": "active",
  "status": "active", "expiresAt": null, "source": "manual", "orderId": null, "customerId": null,
  "recipientName": "Hala", "recipientEmail": "hala@example.com", "message": "Happy birthday", "note": null, "createdAt": "…" }
```
  `state`: active | empty | expired | disabled. `source`: manual | order.
- **POST `/`** `{ "amount": 50000 (minor units, ≥1), "currency": "EGP", "expiresAt"?: future ISO|null, "recipientName"?, "recipientEmail"?, "message"? (≤500), "note"? (≤500, staff only), "sendEmail"?: true }`
  → 201 `{ "giftCard": view, "code": "9KVF-TKVD-7GWL-T6FK" }` — **show the code once** with a copy button ("Save it now").
- **GET `/:id`** → `{ giftCard, transactions: [ { id, kind: issue|redeem|refund|adjust, amount: "-25000", balanceAfter, orderId, note, createdAt } ] }`.
- **PATCH `/:id`** `{ status?: active|disabled, expiresAt?, note?, recipientName?, recipientEmail?, adjustBy?: ±minor (not 0), adjustNote? }` → same as GET.
  422 if an adjustment would go below zero.
- **POST `/:id/code`** `{ "resend": false }` → `{ "code", "sent": false }` (reveal); `resend: true` emails it to the recipient
  (422 `GIFT_CARD_NO_EMAIL`).
- **GET/PUT `/settings`** `{ "productIds": [uuid ≤50], "validityDays": 1–3650 | null }` — products sold as gift cards.

Screens: list with state chips and search; "Issue gift card" dialog; detail drawer with balance, history, disable,
adjust balance, reveal/resend; Settings card "Products sold as gift cards" (product picker) + "Valid for {n} days".

### Storefront
- **POST `/store/:ws/gift-cards/check`** `{ "code" }` (any spacing/case) → `{ "giftCard": { "last4", "balanceAmount": "25000", "currency": "EGP", "state": "active", "expiresAt": null } }`;
  404 `GIFT_CARD_NOT_FOUND`. Rate-limited like order tracking. A "Check your gift card balance" page/modal.
- **Checkout** (`POST /store/:ws/checkout`): new optional **`giftCardCode`**, **with `paymentMethod: "cod"` only** (other methods:
  422 `giftCardCode` "A gift card can be used with cash on delivery"). Checked before the order: 422 `GIFT_CARD_NOT_FOUND` /
  `GIFT_CARD_UNUSABLE` ("has expired", "no balance left", "is no longer valid", "is in USD") on field `giftCardCode`.
  The 201 answer adds `giftCard: { "applied": true, "amount": "25000", "last4", "balanceAmount": "0", "currency" }` and the
  order's `amountPaid` / `financialState` (`paid` when the card covered everything, else `partially_paid`).
  UI: a "Gift card" field under the totals with "Apply" (calls `/check` to preview: "−{min(balance, total)}"), then
  "Pay on delivery: {total − card}". Thank-you page: "Paid with gift card ••••{last4}: {amount}".
- Order page (dashboard): the card shows as a payment "Gift card •••• T6FK". Refunding it (existing refund action) returns
  the amount to the card; cancelling the order returns it by itself.
- Bought gift cards are emailed to the buyer (email template `gift_card`, the store's name and the value).

Wording:
| en | ar |
|---|---|
| Gift cards | كروت الهدايا |
| Issue gift card | اعمل كارت هدية |
| Save this code now — it won't be shown in full again | احفظ الكود ده دلوقتي — مش هيظهر كامل تاني |
| Balance | الرصيد |
| Gift card code | كود كارت الهدية |
| Apply | طبّق |
| Check your gift card balance | اعرف رصيد كارت الهدية |
| Paid with gift card | اتدفع بكارت هدية |
| Pay on delivery | تدفع عند الاستلام |
| A gift card can be used with cash on delivery | كارت الهدية بيتستخدم مع الدفع عند الاستلام |
| Products sold as gift cards | منتجات بتتباع ككروت هدايا |
| Adjust balance | عدّل الرصيد |
| Resend to recipient | ابعته تاني للمستلم |

## 190. Blog: posts, categories, a posts index and the latest posts on the home page — UI: pending

### Dashboard — Store → Blog (permission `website.edit`), `/workspaces/:ws/blog`
- **Categories**: `GET /categories` → `{ categories: [ { id, name, slug, description, position, postsCount } ] }`;
  `POST /categories` `{ name (1–120), slug?, description? (≤500), position? }` → 201 `{ category }`; `PATCH /categories/:id`;
  `DELETE /categories/:id` (its posts stay, uncategorised). Slugs keep Arabic letters ("نصائح-العناية"); 409 `SLUG_TAKEN`.
- **Posts**: `GET /posts?state=draft|published|scheduled&categoryId&q&page&limit` → `{ posts: [summary + state + updatedAt], total, page, limit }`;
  `POST /posts`, `GET /posts/:id`, `PATCH /posts/:id`, `DELETE /posts/:id`. Body:
```json
{ "title": "أفضل نصائح العناية بالبشرة", "slug": "", "excerpt": "…", "coverUrl": "https://…", "authorName": "Mona",
  "tags": ["skin"], "categoryId": "…", "status": "draft" | "published", "publishedAt": "2026-10-10T08:00:00Z" | null,
  "seo": { "title": "", "description": "", "noindex": false },
  "blocks": [
    { "type": "heading", "text": "مقدمة", "level": 2 },
    { "type": "paragraph", "text": "…" },
    { "type": "image", "url": "https://…", "alt": "", "caption": "" },
    { "type": "list", "items": ["…", "…"], "ordered": false },
    { "type": "quote", "text": "…", "cite": "" },
    { "type": "product", "productId": "…" },
    { "type": "button", "label": "تسوق", "url": "/products" },
    { "type": "divider" } ] }
```
  → `{ post: { id, title, slug, excerpt, coverUrl, authorName, tags, category, publishedAt, readingMinutes, state, status, blocks, seo, updatedAt } }`.
  Rules: ≤200 blocks; image/cover URLs https only; button URLs https or a store path starting with "/"; product blocks must be
  this store's products; no HTML anywhere (text is shown as text). `status: "published"` without `publishedAt` publishes now;
  a future `publishedAt` = **scheduled** (goes live by itself). `state` = draft | published | scheduled.
- Screens: Blog list (tabs Drafts / Published / Scheduled, search, category filter), post editor (title, link, cover,
  excerpt, category, tags, author, block editor with the 8 block types, SEO, "Save draft" / "Publish" / "Schedule"),
  Categories manager.

### Storefront — `/store/:ws/blog` (public, cached 60 s)
- `GET /posts?category=<slug>&tag=&page=&limit=12` → `{ posts: [ { id, title, slug, excerpt, coverUrl, authorName, tags, category, publishedAt, readingMinutes } ], total, page, limit, category }` (404 unknown category).
- `GET /posts/:slug` → `{ post: { …summary, blocks, seo }, related: [3 summaries] }`. Product blocks come filled:
  `{ "type": "product", "productId", "product": { "name", "slug", "imageUrl", "price": { "amount", "compareAt", "currency" } } }`
  (a product no longer for sale is dropped). Drafts and scheduled posts: 404.
- `GET /categories` (with `postsCount`), `GET /latest?limit=3` (home page section "From our blog").
- Pages: `/blog` (index with category chips, pagination), `/blog/<slug>` (cover, title, date, reading time, blocks, product
  cards with add to cart, related posts), `/blog?category=<slug>`. The sitemap now lists `/blog` and `/blog/<slug>`.
- Home page section "Latest posts" (3 cards) for themes that want it.

Wording:
| en | ar |
|---|---|
| Blog | المدونة |
| New post | مقال جديد |
| Draft / Published / Scheduled | مسودة / منشور / مجدول |
| Publish / Schedule / Save draft | انشر / جدوِل / احفظ مسودة |
| {n} min read | قراءة {n} دقيقة |
| Related posts | مقالات ذات صلة |
| From our blog | من مدونتنا |
| Read more | اقرأ أكتر |
| Categories | التصنيفات |

## 191. Element display rules: between dates, by device, country or UTM source — UI: pending

Stored on any builder element (store pages and funnel steps), beside its style — no new endpoint for saving, it goes with
the page/step tree as today:
```json
"settings": { "visibility": {
  "from": "2026-11-20T00:00:00Z", "until": "2026-11-30T23:59:59Z",
  "devices": ["mobile", "tablet"],
  "countries": { "mode": "include", "list": ["EG", "SA"] },
  "utm": { "source": ["facebook", "tiktok"], "campaign": ["black-friday"] } } }
```
Validation (422 on save, field `…settings.visibility.*`): only these keys; dates valid and `until` after `from`; devices from
mobile/tablet/desktop; countries `{ mode: include|exclude, list: ["EG", …] }` (upper-case 2 letters, ≤250); utm keys
source/medium/campaign, each a list of ≤20 values. All rules present must pass (AND); within a list, any value matches.

How it applies:
- **Dates — enforced by the backend**: public store pages (`/store/:ws/pages…`) and funnel steps (session step, generic
  pages) are sent **without** elements whose window is closed (before `from`, or after `until`). Pages are cached ~60 s, so
  a window opens/closes within a minute.
- **Device, country, UTM — applied by the storefront** (the page is the same for everyone in the cache):
  **GET `/store/:ws/visitor-context`** (public, not cached) → `{ "country": "EG" | null, "device": "mobile" | "tablet" | "desktop", "now": "…" }`.
  Device from the browser's own width is fine too. UTM from the landing URL's `utm_source/medium/campaign` (keep the first
  ones of the visit in sessionStorage, as the attribution code does). Reference logic (backend `pages/displayRules.evaluate`):
  devices must include the visitor's; `include` needs a known country in the list; `exclude` hides listed countries (an
  unknown country passes); each utm key must equal one value, case-insensitive. Render nothing (no gap) for a hidden element.
  In the builder preview, show every element with a small "Rules" badge.

### Builder UI — element panel → "Display" tab
- "Show between" two date-time pickers (store time zone), "Devices" three toggles, "Countries" include/exclude + multi-select,
  "Only for visitors from" UTM source / medium / campaign tag inputs, "Clear rules".

Wording:
| en | ar |
|---|---|
| Display rules | شروط الظهور |
| Show between | يظهر في الفترة من |
| and | لحد |
| Devices | الأجهزة |
| Mobile / Tablet / Desktop | موبايل / تابلت / كمبيوتر |
| Only in these countries / Everywhere except | في البلاد دي بس / في كل مكان ماعدا |
| Only for visitors from (UTM source) | للزوار اللي جايين من (UTM source) |
| Rules | شروط |
| Clear rules | امسح الشروط |

## 192. Template marketplace: merchants submit funnel templates, the platform reviews, others use them — UI: pending

Free templates only (no price anywhere). Built on the funnel share code's copy: products, offers and bumps are taken out.

### Merchant — `/workspaces/:ws/marketplace` (permission `funnels.manage`)
- **Browse**: `GET /templates?category=&q=&language=ar|en|fr&sort=popular|new&page=&limit=24` →
  `{ templates: [ { id, name, description, category, tags, thumbnailUrl, authorName, language, stepCount, usesCount, createdAt } ], total, page, limit, categories: ["ecommerce","lead_generation","webinar","digital_product","course","service","event","other"] }`.
- **Detail / preview**: `GET /templates/:id` → `{ template: { …card, steps: [ { key, stepType, name } ], pages: [ { key, name, builderData } ] } }`
  (render `builderData` with the page renderer for the preview).
- **Use**: `POST /templates/:id/use` `{ name? }` → 201 `{ funnel: { id, name, status: "draft" }, stepCount }` — open the new funnel's
  editor; its issues list says which pages need a product/offer. Counts against the plan like any new funnel.
- **Submit**: `POST /submissions` `{ funnelId, name (3–120), category, description?, tags? (≤10, lower-cased), thumbnailUrl? (https), authorName? (default: store name), language? }`
  → 201 `{ submission: { …card, status: "pending", reviewNote: null, reviewedAt: null, funnelId, updatedAt } }`.
  422 "The funnel has no pages yet"; 409 `ALREADY_SUBMITTED` (that funnel is pending or listed). The pages are copied
  **at submission**: later edits to the funnel don't change the template until "Resubmit".
- **Mine**: `GET /submissions` → `{ submissions: [...] }` with `status` pending | approved | rejected | withdrawn and the
  reviewer's `reviewNote`. `PATCH /submissions/:id` `{ …card fields, resubmit?: true }` — `resubmit` takes a fresh copy of the
  funnel and goes back to pending; editing a listed card also goes back to review. `DELETE /submissions/:id` → withdrawn
  (removed from the marketplace; funnels already copied stay).

### Platform console — `/admin/marketplace` (platform permission `templates.view` / `templates.manage`)
- `GET /admin/marketplace?status=pending|approved|rejected|withdrawn` → `{ templates: [ …own view + workspaceId ], total }` (oldest first).
- `GET /admin/marketplace/:id` → with `steps`, `pages` (builderData) and `edges` for the review preview.
- `POST /admin/marketplace/:id/review` `{ action: "approve" | "reject" | "unlist", note? }` — reject needs a note (422).

### Screens
- Funnels → "Template marketplace" tab: category chips, search, sort, cards (picture, name, author, pages, uses), preview
  modal with page tabs, "Use this template" (name prompt).
- Funnel editor → "Share to marketplace" (form: name, category, description, tags, picture, author name, language), and
  Funnels → "My submissions" with status badges and the reviewer's note, Edit / Resubmit / Withdraw.
- Platform console → "Marketplace review" queue with preview, Approve / Reject (note) / Unlist.

Wording:
| en | ar |
|---|---|
| Template marketplace | سوق القوالب |
| Use this template | استخدم القالب ده |
| Share to marketplace | شارك في سوق القوالب |
| Pending review / Listed / Needs changes / Withdrawn | مستني المراجعة / منشور / محتاج تعديل / اتسحب |
| Resubmit | ابعته تاني |
| Withdraw | اسحبه |
| {n} pages · used {m} times | {n} صفحات · اتستخدم {m} مرة |
| Products and offers are not copied — pick yours after | المنتجات والعروض مش بتتنقل — اختار بتوعك بعدين |

## 193. Zapier and Make — UI: pending

Connection is an API key (existing Settings → Developers → API keys) on the public API; the mapping to enter in Zapier's /
Make's developer consoles is in `src/modules/publicApi/integrations/README.md`.
- **GET `/api/public/v1/me`** now also returns `store: { id, name, currency }` (the connection label).
- **GET `/api/public/v1/webhooks/samples/:event?limit=3`** (scope `webhooks:write`) → an array of the store's latest real
  payloads of that event, newest first, in the exact delivery shape `{ id, type, createdAt, workspaceId, data }`; with none
  yet, one marked `sample: true`. 404 for an unknown event. Works for every event of `GET /webhooks/events`, including
  `order.created` and `order.status_changed`.
- Subscribe / unsubscribe are the existing `POST /webhooks` `{ url, events }` and `DELETE /webhooks/:id`. A store can now hold
  **25** webhook subscriptions (was 10), since every trigger is one.
- App store: **Zapier** and **Make** cards (category Orders, available to every store) open Settings → Developers.

### Dashboard
- App cards Zapier / Make → a short guide page: "1. Create an API key with the Webhooks scope (and Orders read for order
  fields). 2. In Zapier/Make, search Zimos and paste the key." with a "Create API key" button preselecting the scopes
  `webhooks:write`, `orders:read`.
- Settings → Developers → Webhooks: endpoints whose URL is on hooks.zapier.com or hook.*.make.com get a "Zapier"/"Make" badge.

Wording:
| en | ar |
|---|---|
| Connect Zapier | اربط زابير |
| Connect Make | اربط ميك |
| Create an API key with the Webhooks scope, then paste it in Zapier | اعمل مفتاح API بصلاحية الـ Webhooks، وبعدين الصقه في زابير |
| Your automations | الأتمتة بتاعتك |

## 194. Back-in-stock alerts — UI: pending

### Storefront
- **POST `/store/:ws/stock-alerts`** `{ "variantId", "email" | "phone" (exactly one), "locale"?: ar|en|fr }` → 201
  `{ "subscribed": true, "channel": "email" | "sms" }`. Asking twice is fine (one alert per variant and address).
  409 `IN_STOCK` when the variant can be bought (refresh the page state); 404 for a product not for sale; 422
  `INVALID_PHONE`; 429 after 20 alerts an hour from one visitor.
- Product page / quick view: when the selected variant is sold out (and no overselling), replace "Add to cart" with
  "Notify me when it's back" → email (or phone) field → "Notify me" → "We'll tell you once when it's back".
- The shopper gets one email ("{product} is back in stock", "Order now" button to the product page) or SMS when the
  variant's stock goes from 0 to available. Nothing else is sent to that address.

### Dashboard — Products (permission `products.view`)
- **GET `/workspaces/:ws/stock-alerts`** → `{ "variants": [ { "productId", "productName", "variantId", "sku", "optionValues": { "Size": "M" }, "waiting": 2, "notified": 0, "lastRequestAt" } ] }`
  (most waited first, 200 rows).
- A "Waiting for restock" card on Products/Inventory and a badge "{n} waiting" next to sold-out variants; restocking
  (any stock edit, import or return that makes the variant available) sends the alerts by itself.

Wording:
| en | ar |
|---|---|
| Notify me when it's back | بلغني لما يرجع |
| We'll tell you once when it's back | هنبلغك مرة واحدة لما يرجع |
| Waiting for restock | مستنيين يرجع |
| {n} waiting | {n} مستني |

## 195. Pre-orders — UI: pending

### Dashboard — product page → "Pre-orders" card (view `products.view`, save `products.manage`)
- **GET `/workspaces/:ws/preorders/:productId`** →
```json
{ "productId": "…", "name": "Demo T-Shirt",
  "preorder": { "enabled": true, "shipsAt": "2026-11-15", "limit": 3, "message": "Ships mid-November" },
  "variants": [ { "id": "…", "sku": "DEMO-TSHIRT-M", "optionValues": { "Size": "M" }, "available": -2, "preordered": 2 } ] }
```
- **PUT `/workspaces/:ws/preorders/:productId`** `{ "enabled": true, "shipsAt"?: "YYYY-MM-DD" | null, "limit"?: 1–1000000 | null (no limit), "message"?: ≤200 }` → same shape.
- **GET `/workspaces/:ws/preorders`** → `{ products: [ { productId, name, shipsAt, limit, preordered } ] }` (products taking pre-orders).
- Card: switch "Take pre-orders when sold out", "Expected ship date", "Limit per variant (units beyond stock)", "Message on
  the product page". Variants table shows "Pre-ordered: n".

How it works: when a variant runs out, checkout keeps selling it until `limit` units beyond stock (per variant; no limit
when null) — otherwise 409 `INSUFFICIENT_STOCK` as before. Cancelling orders or adding stock frees room. A line sold beyond
stock gets **`preorderShipsAt`** (on the order's items) and the order gets the tag **`preorder`** (filter orders by tag).

### Storefront
- Product payload (`GET /store/:ws/products/:id` → `product.preorder`): `{ "shipsAt": "2026-11-15", "message": "…", "limited": true }`
  or null. When the selected variant is sold out and `preorder` is set: button "Pre-order", note "Ships by {date}" + message;
  otherwise "Sold out" (and the back-in-stock form, 194).
- Order tracking / thank-you: show "Pre-order — ships by {date}" for items with `preorderShipsAt`.

Wording:
| en | ar |
|---|---|
| Pre-order | اطلبه مسبقًا |
| Ships by {date} | هيتشحن قبل {date} |
| Take pre-orders when sold out | استقبل طلبات مسبقة لما المنتج يخلص |
| Expected ship date | معاد الشحن المتوقع |
| Limit per variant | الحد لكل نوع |
| Pre-ordered | اتطلب مسبقًا |

## 196. Cookie consent — UI: pending

### Dashboard — Store settings → Privacy (permission `website.edit`)
- **GET `/workspaces/:ws/cookie-consent`** → `{ "mode": "off", "countries": null, "policyUrl": null, "texts": {} }`
- **PUT** same `{ "mode": "off" | "notice" | "opt_in", "countries"?: ["DE","FR"] | null, "policyUrl"?: "https://…" | "/pages/privacy" | null, "texts"?: { "ar": { "message", "accept", "reject" }, "en": {…}, "fr": {…} } }`
  (message ≤500, buttons ≤40). Off (default) = no banner, as today. Notice = a banner that informs; tracking runs.
  **Ask first (opt_in)** = nothing tracks until the shopper accepts; `countries` limits who is asked (empty = everyone; an
  unknown country is asked).
- Card: radio Off / Notice only / Ask first, countries multi-select ("Ask only visitors from…"), policy link, texts per language.

### Storefront
- `GET /store/:ws` → `store.cookieConsent`: `{ "mode": "off" }` or `{ mode, countries, policyUrl, texts }`.
- Banner (bottom, both buttons equal): show for `notice` (one "OK" button) and for `opt_in` ("Accept" / "Reject"; when
  `countries` is set, only for visitors whose `GET /store/:ws/visitor-context` country is listed or unknown). Remember the
  choice (localStorage, 6 months) and offer "Cookie settings" in the footer to change it.
- With `opt_in` and no "Accept": **don't load the browser pixels / GTM / Clarity**, and send the choice to the backend:
  - event batches (`POST /store/:ws/events`): add `"consent": { "marketing": true | false }` — without `true` the server
    sends nothing to the ad platforms for that batch;
  - checkout (`POST /store/:ws/checkout`): add `"trackingConsent": true | false` — kept on the order; without `true` the
    order's server-side purchase event is not sent.
  Analytics inside Zimos (visits, funnels) are first-party and keep working.

Wording:
| en | ar |
|---|---|
| We use cookies to improve your visit and measure our ads. | بنستخدم الكوكيز عشان نحسّن زيارتك ونقيس إعلاناتنا. |
| Accept | موافق |
| Reject | لا شكرًا |
| Cookie settings | إعدادات الكوكيز |
| Privacy policy | سياسة الخصوصية |
| Off / Notice only / Ask first | مقفول / إشعار بس / اسأل الأول |
| Ask only visitors from | اسأل بس الزوار من |

## 197. Store gates: password, coming soon, age check — UI: pending

### Dashboard — Store settings → Store access (permission `website.publish`)
- **GET `/workspaces/:ws/store-gate`** → `{ "mode": "off" | "password" | "coming_soon", "hasPassword": true, "message": "Private sale", "opensAt": null, "lockFunnels": false, "ageCheck": { "enabled": true, "minAge": 18, "message": null } }` (the password is never returned).
- **PUT** same `{ "mode", "password"? (4–100; required the first time for password mode), "message"? (≤500), "opensAt"? ISO|null, "lockFunnels"?, "ageCheck"?: { "enabled", "minAge" 13–25, "message"? } }`.
  Changing the password signs every visitor out.
- **GET `/workspaces/:ws/store-gate/signups`** → `{ signups: [ { email, locale, createdAt, notifiedAt } ], total }` (export as CSV
  client-side; "Email them when you open" can use the email campaigns of item 200).
- Card: radio Open / Password / Coming soon; password field; message; opening date; "Also lock funnels" switch;
  Age check switch + minimum age + message; "Sign-ups ({n})" link.

### Storefront
- `GET /store/:ws` → `store.gate`: `{ mode, message, opensAt, ageCheck }`. When `mode` ≠ off, every store route except the
  gate's answers **423 `STORE_LOCKED`** with `details.gate` — show the gate page instead of the store:
  - password: message + password field → **POST `/store/:ws/gate/unlock`** `{ password }` → `{ token, expiresInSeconds }` (30 days);
    send it as header **`X-Store-Gate`** on every store call (localStorage). 422 `WRONG_PASSWORD`.
  - coming soon: message, countdown to `opensAt` if set, and the email form.
  - both: **POST `/store/:ws/gate/signup`** `{ email, locale? }` → 201 `{ signedUp: true }` (same email twice is fine).
- Still open while locked: order tracking and payment returns, downloads, courses, subscriptions, affiliate portal,
  analytics events, fonts, visitor context — and funnels unless `lockFunnels`. Staff previews (X-Store-Preview) pass.
- Age check (`ageCheck.enabled`): a full-screen "Are you {minAge} or older?" before entering (Yes → remember for the
  session; No → a "Sorry" screen). It is the shopper's own answer, not a lock.

Wording:
| en | ar |
|---|---|
| This store is password protected | المتجر ده محمي بباسورد |
| Enter password | اكتب الباسورد |
| Opening soon | هنفتح قريب |
| Tell me when you open | بلغني لما تفتحوا |
| Are you {n} or older? | عندك {n} سنة أو أكتر؟ |
| Yes / No | أيوه / لأ |
| Store access | الدخول للمتجر |
| Open / Password / Coming soon | مفتوح / بباسورد / قريبًا |
| Also lock funnels | اقفل الفانلز كمان |

## 198. Purchase limits per product — UI: pending

### Dashboard — product page → "Purchase limits" (view `products.view`, save `products.manage`)
- **GET `/workspaces/:ws/purchase-limits/:productId`** → `{ "productId", "limits": { "min": 2, "max": 3, "maxPerCustomer": 4 } }` (nulls = no limit).
- **PUT** same `{ "min"?, "max"?, "maxPerCustomer"? }` (1–100000 or null; min ≤ max; maxPerCustomer ≥ max). `{}` clears them.
- Fields: "Minimum per order", "Maximum per order", "Maximum per customer (all orders)". Units count every variant and
  offer of the product together. Staff-created orders are not limited.

### Storefront
- Product payload: `product.purchaseLimits` = `{ min, max, maxPerCustomer }` or null — set the quantity picker's min/max and
  show "Max {n} per order" / "Min {n}".
- Cart (`POST /store/:ws/cart/items`, `PATCH /cart/items/:id`): 422 when the product's units in the cart would pass `max`,
  `details: [{ field: "quantity", message: "At most 3 of \"…\" per order", productId, max }]`.
- Checkout (`POST /store/:ws/checkout`): 422 with `details: [{ field: "items", message, productId, min | max | maxPerCustomer, left? }]` —
  messages "Order at least 2 of …", "At most 3 of … per order", "You can buy 1 more of …" / "You already bought the most …
  one customer can" (per customer = earlier orders by the same phone that were not cancelled). Show the message on the
  product's line.

Wording:
| en | ar |
|---|---|
| Purchase limits | حدود الشراء |
| Minimum per order | أقل كمية في الطلب |
| Maximum per order | أكبر كمية في الطلب |
| Maximum per customer | أكبر كمية للعميل الواحد |
| Max {n} per order | بحد أقصى {n} في الطلب |
| You can buy {n} more | تقدر تشتري {n} كمان |

## 199. Estimated delivery dates — UI: pending

### Dashboard — Shipping → Delivery times (permission `shipping.manage`)
- **GET `/workspaces/:ws/delivery-estimates`** →
```json
{ "enabled": true, "default": { "minDays": 2, "maxDays": 4 }, "regions": { "cairo": { "minDays": 1, "maxDays": 2 } },
  "places": { "<store place id>": { "minDays": 1, "maxDays": 1 } }, "cutoffHour": 14, "skipDays": [5] }
```
- **PUT** same shape (`enabled` required; days 0–90 / 0–120, min ≤ max; `regions` keyed by the platform governorate codes of
  `/geo` lists, ≤100; `places` keyed by store place ids (item 163), ≤2000; `cutoffHour` 0–23 or null; `skipDays` 0=Sunday…6).
- Screen: switch; default min–max days; a table of governorates (and, when the store has its own places, cities/areas)
  with min–max; "Orders after {hour} ship the next day"; "Days we don't deliver" (weekday chips).

### Storefront
- **GET `/store/:ws/delivery-estimate?province=&city=&area=&placeId=&country=`** (public, cached 5 min) →
  `{ "estimate": { "minDays": 1, "maxDays": 2, "from": "2026-10-08", "to": "2026-10-10", "source": "place:area" | "region" | "default" } }`
  or `{ "estimate": null }` (off). Working days in the store's time zone, after the cutoff, skipping `skipDays`.
- Product page: "Get it {from} – {to}" (with the visitor's saved/selected governorate, else the default). Cart and checkout:
  the shipping quote (`POST /store/:ws/shipping-quote`) now returns `quote.deliveryEstimate` for the address.
- The window is kept on the order (`shippingSnapshot.deliveryEstimate`) and shown on tracking (`result.deliveryEstimate`)
  and the thank-you page: "Expected {from} – {to}".

Wording:
| en | ar |
|---|---|
| Get it {from} – {to} | هيوصلك من {from} لـ {to} |
| Expected delivery | التوصيل المتوقع |
| Delivery times | مواعيد التوصيل |
| Orders after {hour} ship the next day | الطلبات بعد الساعة {hour} بتتشحن تاني يوم |
| Days we don't deliver | أيام مفيش فيها توصيل |

## Frontend requests (2026-10-06, second batch, docs/ux/backend-requests.md) — done

### CORS: `X-Shopper-Token` — done
The store API (`/api/v1/store/...`) preflight now allows **`X-Shopper-Token`** (signed-in shopper, 185/186) and
**`X-Store-Gate`** (password-unlocked store, 197). Nothing to change in the UI.

### App store: Shopify and WooCommerce — done
`GET /workspaces/:ws/apps`: `shopify` and `woocommerce` are now `availability: "available"` with
**`openPath: "/apps/dropshipping"`** (they open the dropship page's «متجرك التاني» section, 181).

### Product link import report (180) — done
`GET /workspaces/:ws/catalog/imports/:importId` (and the list) now also return, once the import has run:
```json
{ "import": { "id": "…", "kind": "etsy_link", "status": "done", "total": 1, "createdCount": 1, "failedCount": 0, "errors": [],
  "productIds": ["aec481c7-…"],
  "results": [{ "row": 1, "productId": "aec481c7-…", "name": "Wooden lamp", "sourceCurrency": "USD", "reviewsImported": 12 }],
  "reviewsImported": 12 } }
```
`sourceCurrency` is the page's price currency (null when the page gives none, or for files and Shopify links); `reviewsImported`
counts the imported reviews held as `pending`. Imports from before this change have empty `results`/`productIds`. UI: open the
new draft by `productIds[0]` and show «السعر بعملة الصفحة: USD — راجعه قبل النشر» / "Price is in USD — check it before
publishing" and «اتنقل 12 تقييم مستنيين موافقتك» / "12 reviews imported, waiting for your approval".

### Own error codes for link refusals (180) — done
`POST /workspaces/:ws/catalog/products/import` with `{ url }` answers 422 with its own `code` for each refusal (store and
Shopify links alike; `details[0].field` stays `url`):

| code | when | en | ar |
|---|---|---|---|
| `LINK_INVALID` | not a full link | Paste the full product link, starting with https:// | الصق لينك المنتج كامل، بيبدأ بـ https:// |
| `LINK_NOT_HTTPS` | http, ftp… | The link must start with https:// | اللينك لازم يبدأ بـ https:// |
| `LINK_HAS_CREDENTIALS` | user:pass@ in the link | The link must not contain a username or password | اللينك ميكونش فيه اسم مستخدم أو باسورد |
| `LINK_NOT_PRODUCT` | not a product link of AliExpress, Etsy, CJ, YouCan or a Shopify store (/products/…) | This is not a product link we can import | ده مش لينك منتج نقدر نستورده |
| `LINK_NO_PRODUCT_DATA` | the page publishes no product data / the Shopify link returned no product | That page does not show its product details — import a sheet instead | الصفحة دي مش بتنشر بيانات المنتج — استورده من شيت |
| `IMPORT_SOURCE_UNREACHABLE` | the page could not be read (timeout, 404…) | We could not reach that page — try again later | مقدرناش نوصل للصفحة — جرب تاني بعدين |

## 200. Email campaigns — WITHDRAWN, do not build

The email campaigns backend (`/workspaces/:ws/email-campaigns`, `/email-campaigns/open`) was removed again: SPEC §21
forbids campaigns of any kind, email blasts included (owner, 2026-10-03). If any screen, api-client call or menu entry
for it was started, please remove it. Nothing else changes: the abandoned-cart email's unsubscribe page works as before,
and it now also works while a store is locked by a store gate.

## 201. Gift cards with online payments — UI: pending

`POST /store/:ws/checkout` now takes **`giftCardCode` with online payments** too (card / wallet / any gateway method), not
only cash on delivery. Bank transfer still refuses it (422 on `giftCardCode`: "A gift card can be used with cash on delivery
or an online payment").

- The card's part is **held** at checkout and the gateway is asked only for the rest. The response's `giftCard`:
  `{ "applied": true, "held": true, "amount": "5000", "last4": "LFDM", "balanceAmount": "0", "currency": "EGP" }`
  (`applied: false` + `reason`: `unusable` | `nothing_due` | `error` | `covers_order_cod_unavailable` — then the gateway charges the
  full total). `payment.redirectUrl` charges total − card.
- Paid at the gateway → the order shows two payments (gateway + `gift_card`), `amountPaid = totalAmount`, `paid`.
- Expired unpaid or cancelled → the hold goes back to the card (card ledger: `hold_released` + `release`).
- **Switch to cash on delivery** → the card pays its part now; the courier collects the rest.
- **Card covers the whole order** → no gateway at all: 201 with **`paidByGiftCard: true`**, `order.paymentMethod: "cod"`,
  `financialState: "paid"`, no `payment` object. (If the store has cash on delivery off, the hold is undone and the gateway
  charges the full total; `giftCard.reason: "covers_order_cod_unavailable"`.)

Shopper payment status (`GET /store/:ws/orders/:id/payment`) has two new fields: **`giftCardHeld`** (the held amount) and
**`amountDue`** (total − paid − held). A cash-on-delivery order partly paid by a card or deposit now reads `status: "cod"`
(it read `paid` before).

Card ledger (`GET /workspaces/:ws/gift-cards/:id` → `transactions[].kind`) has new kinds: `hold` (held for an unpaid online
order), `hold_released`, `release` (given back). A captured hold reads `redeem` as before.

### Storefront
- Checkout: show the gift card field for every payment method except bank transfer; after it's applied show
  «كارت الهدية هيدفع 50 ج.م — هتدفع الباقي 200 ج.م أونلاين» / "Your gift card pays EGP 50 — pay the remaining EGP 200 online".
- When the response has `paidByGiftCard: true`, go straight to the thank-you page: «كارت الهدية دفع الطلب كله» / "Your gift
  card paid for the whole order".
- Payment page / retry: show `amountDue` as the amount to pay and, when `giftCardHeld > 0`, a line «من كارت الهدية: 50 ج.م» /
  "From gift card: EGP 50".
- Expired order page: «رجعنا رصيد كارت الهدية» / "Your gift card balance was returned".

### Dashboard
- Gift card detail ledger: labels for the new kinds — hold «محجوز لطلب» / "Held for an order", release «رجع للكارت» /
  "Returned to card", hold_released «اتفك الحجز» / "Hold released".

## 202. Scheduled summary reports — UI: pending

A daily and/or weekly summary email to chosen team members, with the dashboard home's numbers against the period before:
sales, orders, average order, confirmation rate, delivery rate, new customers, lost orders, net profit, and the top 5
products. Sent at the chosen hour in the store's time zone, once per period, in each member's dashboard language.

### Endpoints — `/api/v1/workspaces/:ws/scheduled-reports`
- `GET /` (`analytics.view`) →
```json
{ "daily": { "enabled": true, "hour": 9 }, "weekly": { "enabled": false, "weekday": 6, "hour": 9 },
  "recipientUserIds": ["…"], "timeZone": "Africa/Cairo",
  "members": [{ "userId": "…", "email": "sara@store.com", "fullName": "Sara", "locale": "ar" }],
  "lastSent": [{ "kind": "daily", "periodKey": "2026-10-07", "sentCount": 2, "sentAt": "…" }] }
```
  `members` = active members who can see analytics (the only ones who can be chosen).
- `PUT /` (`workspace.manage`) `{ daily: { enabled, hour 0–23 }, weekly: { enabled, weekday 0–6 (0 Sunday … 6 Saturday), hour }, recipientUserIds: [≤50] }`
  → same as GET. 422 on `recipientUserIds`: "Only active team members who can see analytics can get reports" / "Choose who gets the report" (a report on with nobody chosen).
- `GET /preview?kind=daily|weekly` (`analytics.view`) → `{ report, email: { subject, html, text } }`; `report` =
  `{ kind, fromDay, lastDay, currency, metrics: [{ key, type: money|count|rate, label: { en, ar }, value, previous, changePercent, changePoints }], topProducts: [{ productId, name, quantity, sales }] }`
  (money in minor units; rates in %, their change in points).
- `POST /send-test` `{ kind }` (`analytics.view`) → `{ sent: true, email }`: the report now, to the signed-in member only.

Daily covers yesterday (store time); weekly covers the 7 days before the send day.

### Screen — Settings → Notifications → "Summary reports" (or Analytics → "Email reports")
- Two cards: «تقرير يومي» / "Daily report" (toggle + hour) and «تقرير أسبوعي» / "Weekly report" (toggle + day + hour),
  hours shown in the store's time zone «بتوقيت المتجر (القاهرة)» / "Store time (Cairo)".
- «مين يستلم التقرير» / "Who gets it": checkboxes from `members` (name + email).
- Buttons: «معاينة» / "Preview" (render `email.html` in a frame) and «ابعتهولي دلوقتي» / "Send it to me now".
- Footer: last sent from `lastSent` «آخر تقرير اتبعت: …» / "Last sent: …".
- Hint when no member has analytics access: «مفيش حد في الفريق يقدر يشوف التحليلات» / "No team member can see analytics".

## 203. Loyalty points — UI: pending

Customers earn points on delivered orders and spend them at checkout. Spending needs a **signed-in shopper**
(`X-Shopper-Token`, shopper accounts from 185 must be on). The merchant sets every number; with no earn rate or point
value the programme stays off.

### Settings — `/api/v1/workspaces/:ws/loyalty`
- `GET /` (`customers.view`) → `{ settings: { enabled, earnPointsPerUnit, pointValue, minRedeemPoints, maxRedeemPercent, expiryDays }, active, currency, customersWithPoints, outstandingPoints, outstandingWorth }`
  (`active` = enabled and fully set; `outstandingWorth` in minor units).
- `PUT /` (`discounts.manage`) `{ enabled, earnPointsPerUnit (0.01–1000, points per 1 unit of the store currency), pointValue (int minor units per point, e.g. 10 = EGP 0.10), minRedeemPoints (≥1, default 1), maxRedeemPercent (1–100, default 100), expiryDays (30–1825 or null) }` — `earnPointsPerUnit` and `pointValue` required when `enabled`.
- `GET /customers/:customerId` (`customers.view`) → `{ balance, worth, currency, expiresAt, history: [{ kind, points, balanceAfter, amount, currency, orderId, note, createdAt }] }`
- `POST /customers/:customerId/adjust` (`customers.manage`) `{ points: ±int (not 0), note (1–200) }` → `{ balance, applied }` (never below 0).

History `kind`s: `earn`, `redeem`, `hold` (for an unpaid online order), `release` (given back), `refund` (refund of a points payment), `reverse` (taken back: return/cancel), `expire`, `adjust`.

### Storefront
- `GET /store/:ws/loyalty` → `{ program: { earnPointsPerUnit, pointValue, minRedeemPoints, maxRedeemPercent, expiryDays, currency } | null }` (5-min cache).
- `GET /store/:ws/account/loyalty` (X-Shopper-Token) → `{ program, balance, worth, currency, expiresAt, history }`.
- Checkout `POST /store/:ws/checkout` takes **`loyaltyPoints`** (int) with `X-Shopper-Token`, with COD or online (not bank transfer).
  Errors (on `loyaltyPoints`): 401 `SHOPPER_NOT_SIGNED_IN`, 422 `LOYALTY_OFF`, `LOYALTY_TOO_FEW`, `LOYALTY_NOT_ENOUGH`.
  Response `loyalty`: `{ applied: true, held: false|true, points: 1000, amount: "10000", balance: 2000, currency: "EGP" }`. Fewer points than asked may be used: at most `maxRedeemPercent` of the total and what's still due.
  COD: paid at once (order `partially_paid`). Online: held, and the gateway charges the rest. The hold is taken when paid, or on a switch to COD, and returned on expiry or cancel (same as gift cards, 201).
  Points (plus any gift card) covering the whole order → COD with nothing to collect: `paidInStore: true` (and `paidByGiftCard` when a card took part).
- Shopper payment status adds **`pointsHeld`** (beside `giftCardHeld` and `amountDue`).

### Screens
- Dashboard → Customers → **Loyalty programme**: toggle, «كل 1 ج.م = X نقطة» / "Points per EGP 1", «قيمة النقطة» / "Value of a point" (show "100 points = EGP 10"), min points, max % of an order, expiry «النقط بتنتهي بعد X يوم من غير شرا» / "Points expire after X days without activity". Summary: customers with points, outstanding points and their worth.
- Customer page: balance card + history + «إضافة/خصم نقط» / "Add or take points" (points, note).
- Storefront product page: «هتكسب 250 نقطة» / "Earn 250 points" (price ÷ 100 × earnPointsPerUnit, rounded down).
- Checkout (signed in): «استخدم نقطك (عندك 2000 = 200 ج.م)» / "Use your points (2000 = EGP 200)" with an amount field; not signed in: «سجّل دخول عشان تستخدم نقطك» / "Sign in to use your points".
- Account → «نقطي» / "My points": balance, worth, expiry date, history.
- Refunds: the merchant can refund a gift-card or points payment by its `paymentId` too (it goes back to the card or the points). Before this, only gateway payments could be named.

## 204. Store credit — UI: pending

Money a customer holds at the store (store currency, minor units). Staff give it, or refund an order to store credit
instead of money. A **signed-in shopper** (`X-Shopper-Token`) spends it at checkout, with COD or online (not bank
transfer), exactly like gift cards and points.

### Staff — `/api/v1/workspaces/:ws/store-credit`
- `GET /` (`customers.view`) → `{ spendingEnabled, customers: [{ customerId, fullName, phone, email, balance }], outstanding, currency }` (holders, biggest first, 500 max).
- `PUT /settings` (`discounts.manage`) `{ enabled }` — whether shoppers may spend credit at checkout (default on).
- `GET /customers/:customerId` (`customers.view`) → `{ balance, currency, history: [{ kind, amount, balanceAfter, currency, orderId, note, createdAt }] }`.
  Kinds: `grant`, `adjust` (taken off), `refund_credit` (an order refunded as credit), `redeem`, `hold`, `release`, `refund` (refund of a credit payment).
- `POST /customers/:customerId/adjust` (`refunds.manage`) `{ amount: ±int minor units (not 0), note }` → `{ balance, applied }`; taking more than the balance → 422 `STORE_CREDIT_NOT_ENOUGH`.
- `POST /orders/:orderId/refund` (`refunds.manage`) `{ amount, reason }` → 201 `{ refund: { id, amount, status: "processed", reason: "Store credit: …" }, balance }`.
  A normal refund of the order (counted in `amountRefunded`, with a credit note), paid onto the customer's credit. At most
  what was paid and not refunded (422 `REFUND_EXCEEDS_ELIGIBLE_AMOUNT`). 422 `ORDER_HAS_NO_CUSTOMER` / `STORE_CREDIT_CURRENCY` (other currency).
- The normal refund endpoint can name a `store_credit` payment by `paymentId` (puts it back on the balance), like gift cards and points.

### Storefront
- Checkout `useStoreCredit: true` (+ `X-Shopper-Token`): uses as much credit as the order takes. Response `storeCredit`: `{ applied, held, amount, balance, currency }`.
  Errors on `useStoreCredit`: 401 `SHOPPER_NOT_SIGNED_IN`, 422 `STORE_CREDIT_EMPTY`, `STORE_CREDIT_OFF`.
- Online: held, and the gateway charges the rest; taken on payment, returned on expiry or cancel. Shopper payment status adds `storeCreditHeld`. Covering the whole order → `paidInStore: true`.
- `GET /store/:ws/account/store-credit` (X-Shopper-Token) → `{ spendingEnabled, balance, currency, history }`.

### Screens
- Customer page: «رصيد المتجر» / "Store credit" card with balance and history; «إضافة رصيد» / "Add credit" and «خصم رصيد» / "Take credit" (amount + note).
- Order page → Refund: a choice «ترجيع فلوس» / "Refund money" or «ترجيع كرصيد في المتجر» / "Refund as store credit" (the second calls `/store-credit/orders/:id/refund`).
- Customers → «أرصدة العملاء» / "Store credit balances": list + total outstanding; toggle «العملاء يقدروا يستخدموا رصيدهم في الدفع» / "Customers can spend credit at checkout".
- Checkout (signed in, balance > 0): checkbox «استخدم رصيدك (150 ج.م)» / "Use your store credit (EGP 150)".
- Account: «رصيدي» / "My credit" with the history.

## 205. Wholesale price lists — UI: pending

Prices for customers with a tag (e.g. `wholesale`), applied only when they are **signed in** (`X-Shopper-Token`). A list
is either a **percent** off (every product or chosen products) or **fixed** prices per variant with minimum quantities
(tiers). A line gets the lowest price among its normal price and every list that matches it. Offer bundles and funnels keep
their own prices.

### Staff — `/api/v1/workspaces/:ws/price-lists` (read `products.view`, change `products.manage`)
- `GET /` → `{ priceLists: [PriceList] }`; `GET /:id`; `DELETE /:id` → 204.
- `POST /` (201) and `PUT /:id` (full replace):
```json
{ "name": "Wholesale", "customerTags": ["wholesale"], "kind": "fixed",
  "prices": [{ "variantId": "…", "minQuantity": 1, "priceAmount": 20000 }, { "variantId": "…", "minQuantity": 5, "priceAmount": 18000 }],
  "isActive": true }
{ "name": "VIP", "customerTags": ["vip"], "kind": "percent", "percent": 30, "productIds": ["…"] }   // productIds null/[] = all products
```
  Rules: name 1–120; 1–20 tags (stored lower-case, matched to the contact's tags); percent 1–90; fixed: 1–2000 rows, one per
  variant + minQuantity, priceAmount ≥ 0 minor units; every variant/product must be the store's (422 otherwise).
  PriceList = the body plus `id`, `createdAt`, `updatedAt` (`prices[].priceAmount` as strings).

### Storefront
- `GET /store/:ws/price-list?variantIds=a,b,c` (≤100, with `X-Shopper-Token`) → `{ priceList: "Wholesale" | null, prices: [{ variantId, basePrice, tiers: [{ minQuantity, priceAmount }] }] }`
  — only variants with a lower price for this shopper; empty when not signed in or not tagged.
- Cart (`/store/:ws/cart…`): send `X-Shopper-Token` too and `items[].currentUnitPrice` / `subtotal` include the list price for the line's quantity.
- Checkout: send `X-Shopper-Token` — the order is priced with it (server-side).

### Screens
- Products → «قوايم الأسعار» / "Price lists": list (name, tags, type, active), editor with tags, type switch
  «نسبة خصم» / "Percent off" (percent + product picker «كل المنتجات» / "All products") or «أسعار ثابتة» / "Fixed prices"
  (variant picker → rows of «من كمية» / "From quantity" + «السعر» / "Price").
- Customer page: hint that the tag gives wholesale prices «العميل ده بياخد أسعار: Wholesale» / "This customer gets: Wholesale prices".
- Storefront product page (signed-in, tiers present): «سعرك: 200 ج.م بدل 250» / "Your price: EGP 200 instead of 250" and the tier table
  «من 5 قطع: 180 ج.م» / "From 5 pieces: EGP 180"; cart lines show the reduced price.

## 206. Multiple stock locations — UI: pending

Warehouses / shops with their own stock. The store's sellable stock is unchanged (the variant's total). Locations split
it: each non-default location keeps its own count; **the default location holds the rest**. A second location needs the
plan feature `multi_warehouse` (403 `FEATURE_NOT_IN_PLAN`). The first one is free and becomes the default.

### Endpoints — `/api/v1/workspaces/:ws/stock-locations` (read `inventory.view`, change `inventory.manage`)
- `GET /` → `{ locations: [{ id, name, address, isDefault, priority, isActive, totals: { units }, createdAt }], multiWarehouse }`
- `POST /` `{ name (1–120), address? (≤300), priority? (0–1000, lower ships first) }` → 201 location (max 50).
- `PATCH /:id` `{ name?, address?, priority?, isActive?, isDefault: true? }` — making a location the default re-splits the counts so every location keeps its units. The default cannot be switched off.
- `DELETE /:id` → 204; 409 `LOCATION_HAS_STOCK` (transfer it first), 409 `LOCATION_IS_DEFAULT` (make another the default first).
- `GET /:id/stock?productId=&q=` → `{ location, variants: [{ variantId, productId, productName, sku, optionValues, onHand, reserved, available }] }` (500 max).
- `GET /by-variant?variantIds=a,b` → `{ variants: [{ variantId, locations: [{ locationId, name, isDefault, onHand, reserved, available }] }] }` — for the product page.
- `POST /:id/adjust` `{ variantId, delta (±, not 0), reason (1–200) }` → the variant's by-variant view. Receiving or writing off stock at a location: the store total moves with it (a stock movement named "<location>: <reason>"). 422 `INSUFFICIENT_STOCK` below 0.
- `POST /transfers` `{ fromLocationId, toLocationId, lines: [{ variantId, quantity }] (≤500), note? }` → 201 `{ transfer }`; at most what is free (on hand − reserved) at the source, else 422 `INSUFFICIENT_STOCK` with `details[0].available`. The store total doesn't change.
- `GET /transfers` → `{ transfers: [{ id, fromLocationId, toLocationId, lines, note, actorUserId, createdAt }] }` (200 latest).
- `PUT /orders/:orderId` (`orders.manage`) `{ locationId }` → `{ orderId, location }`: where the order ships from.

Orders: `order.stockLocationId` (null = the default). A new order is assigned automatically to the first active location by
`priority` that has every line free; otherwise the default.

### Screens
- Settings → «المخازن» / "Locations": list with units, add/edit (name, address, priority «الأولوية في الشحن» / "Shipping priority"), «اجعله الأساسي» / "Make default", active toggle; upgrade prompt when `multiWarehouse` is false and one exists.
- Location page: stock table (on hand / reserved / available) with search, «استلام / خصم» / "Receive / write off" (delta + reason).
- «نقل مخزون» / "Transfer stock": from → to, variant lines with quantities (show available at source), note; transfers history.
- Product page (dashboard): stock per location under each variant.
- Order page: «بيتشحن من» / "Ships from" select (PUT /orders/:id); print it on the packing slip.
- Negative `available` at a location = more reserved there than on hand: show a warning «محتاج نقل مخزون» / "Needs a transfer".

## 207. Suppliers, purchase orders and stock counts — UI: pending

All under `/api/v1/workspaces/:ws/purchasing` — read `inventory.view`, change `inventory.manage`. Money in minor units.

### Suppliers
- `GET /suppliers` → `{ suppliers: [{ id, name, contactName, phone, email, address, notes, createdAt }] }`
- `POST /suppliers` `{ name (1–160), contactName?, phone?, email?, address?, notes? }` → 201; `PATCH /suppliers/:id`; `DELETE /suppliers/:id` → 204 (409 `SUPPLIER_IN_USE` when it has purchase orders).

### Purchase orders
- `GET /purchase-orders?status=&supplierId=` → `{ purchaseOrders: [{ id, number: "PO-0001", status, supplier: { id, name }, locationId, currency, expectedAt, totalAmount, unitsOrdered, unitsReceived, lineCount, … }] }`
- `POST /purchase-orders` / `PUT /purchase-orders/:id` (draft only, else 409 `PO_LOCKED`):
  `{ supplierId, locationId? (stock location, item 206), expectedAt?, note?, lines: [{ variantId, quantity, unitCost }] (1–500, one per variant) }`
- `GET /purchase-orders/:id` → `{ …, lines: [{ id, variantId, sku, productName, optionValues, quantity, receivedQuantity, unitCost, lineTotal }], totalAmount, unitsOrdered, unitsReceived }`
- `POST /:id/order` (draft → ordered), `POST /:id/cancel` (draft/ordered with nothing received) — else 409 `PO_STATUS`.
- `POST /:id/receive` `{ lines: [{ lineId, quantity }], updateCost?: true }` → the order with status `partially_received` / `received`.
  Adds the units to stock (at the order's location) and sets the variant cost to the weighted average of the stock it had and the units received (unless `updateCost: false`). 422 `PO_OVER_RECEIVED` with `details[0].left`; 409 `PO_STATUS` before it is ordered.

### Stock counts
- `POST /stock-counts` `{ locationId?, productId? | variantIds? (≤2000), note? }` → 201 count. No ids = every variant (2000 max). `expected` = on hand now, at the location or the whole store.
- `GET /stock-counts` (list), `GET /stock-counts/:id` → `{ id, locationId, status: open|applied|cancelled, note, lines: [{ variantId, sku, productName, expected, counted, difference, appliedDelta }], counted, total }`
- `PATCH /stock-counts/:id` `{ lines: [{ variantId, counted (≥0 or null) }] }` — save as you go.
- `POST /stock-counts/:id/apply` → each counted line is adjusted by counted − on hand **at that moment** (`appliedDelta`); `POST /:id/cancel`. 409 `COUNT_CLOSED` after.

### Screens
- Inventory → «الموردين» / "Suppliers" (list + form).
- Inventory → «أوامر الشراء» / "Purchase orders": list with status chips (مسودة Draft · اتطلب Ordered · استلام جزئي Partly received · اتسلّم Received · ملغي Cancelled); editor (supplier, location, expected date, lines with variant picker, quantity, unit cost, total); «اطلب» / "Mark as ordered"; «استلام» / "Receive" with quantity per line (default = what's left) and «حدّث التكلفة» / "Update cost" checkbox.
- Inventory → «الجرد» / "Stock counts": start (location, product or all), a counting table (expected, counted input, difference coloured), «اعتمد الجرد» / "Apply count" with a confirm «هيعدّل المخزون بالفرق» / "Stock will be adjusted by the differences".

## 208. Free gift with purchase — UI: pending

### Rules — `/api/v1/workspaces/:ws/free-gifts` (read `products.view`, save `discounts.manage`)
- `GET /` → `{ rules: [Rule] }`
- `PUT /` `{ rules: [Rule] }` (≤20, replaces all) → `{ rules }` (ids added to new rules — send them back on later saves):
```json
{ "id": "…", "name": "Spend 400, get a tote", "giftVariantId": "…", "quantity": 1,
  "minSubtotal": 40000, "productIds": null, "startsAt": null, "endsAt": null, "active": true }
```
  At least one of `minSubtotal` (minor units) and `productIds` (any of them in the cart); both set = both must hold. quantity 1–10.
  422 when a variant/product isn't the store's or a rule ends before it starts.

### Storefront
- Cart responses carry **`freeGifts`**: `[{ ruleId, name, gift: { variantId, productName, optionValues, quantity }, eligible, outOfStock, missingAmount, needsProduct }]`.
- The checkout adds earned gifts itself (a line at price 0, only while the gift is in stock; one per gift variant). The shopper never adds them, and they drop out by themselves when the cart stops qualifying. Funnel checkouts get no gifts.
- Order lines at 0 are the gifts.

### Screens
- Marketing → «هدايا مع الطلب» / "Free gifts": rule list + editor (gift product/variant picker, quantity, «لما الطلب يوصل لـ» / "When the order reaches" amount, and/or «لما يكون في السلة» / "When the cart has" product picker, dates, active).
- Cart / cart drawer: eligible → «🎁 هدية مجانية: Gift tote bag» / "Free gift: Gift tote bag" as a line at 0; not yet → progress «زوّد 150 ج.م وخد Gift tote bag هدية» / "Add EGP 150 more to get a Gift tote bag free"; out of stock → hide.
- Order page: badge «هدية» / "Gift" on lines priced 0.

## 209. Notes and follow-ups on customers — UI: pending

All under `/api/v1/workspaces/:ws/customer-notes` (`customers.view` unless noted).

- `GET /customers/:customerId` → `{ notes: [Note], followups: [Followup] }` (pinned notes first; open follow-ups first).
- `POST /customers/:customerId/notes` `{ body (1–5000), isPinned? }` → 201 Note. `PATCH /notes/:id` `{ body?, isPinned? }`, `DELETE /notes/:id` → 204 — the author only, or someone with `customers.manage` (else 403).
  Note = `{ id, customerId, body, isPinned, author: { id, fullName }, createdAt, updatedAt }`.
- `POST /customers/:customerId/followups` `{ title (1–200), dueAt (ISO), assigneeUserId? (default: me; null = whole team) }` → 201 Followup. The assignee must be an active teammate who can see customers (422).
- `PATCH /followups/:id` `{ title?, dueAt?, assigneeUserId?, done? }` (a new time or assignee is reminded again); `DELETE /followups/:id` (`customers.manage`).
- `GET /followups?all=true&dueBefore=` → `{ followups: [Followup + customer { id, fullName, phone }], overdue }`: open ones, mine by default, soonest first.
  Followup = `{ id, customerId, title, dueAt, doneAt, overdue, assignee: { id, fullName } | null, createdBy, createdAt }`.
- When a follow-up falls due, its assignee gets the merchant notification **`customer.followup`** once (bell and email by default; it shows in the notification preferences): title «متابعة: …» / "Follow-up: …", link `/customers/:id`, `data: { followupId, customerId, customerName, title }`.

### Screens
- Customer page: «ملاحظات» / "Notes" (add box, pin toggle, edit/delete own), «متابعات» / "Follow-ups" (add: title, date/time, assignee; tick done; overdue in red «متأخرة» / "Overdue").
- Dashboard home / Customers: «متابعاتي» / "My follow-ups" list with the overdue count badge; «كل الفريق» / "Whole team" toggle (`all=true`).
- Notification preferences: the new type «متابعة عميل» / "Customer follow-up".

## 210. Size charts — UI: pending

### Staff — `/api/v1/workspaces/:ws/size-charts` (read `products.view`, change `products.manage`)
- `GET /` → `{ sizeCharts: [Chart] }`; `GET /:id`; `POST /` (201); `PUT /:id` (full); `DELETE /:id` → 204.
```json
{ "name": "T-shirts", "unit": "cm",
  "columns": [{ "ar": "المقاس", "en": "Size" }, { "ar": "الصدر", "en": "Chest" }, { "ar": "الطول", "en": "Length" }],
  "rows": [["S", "96", "68"], ["M", "102", "70"]],
  "note": { "ar": "المقاسات بالسنتيمتر", "en": "Sizes in cm" }, "imageUrl": "https://…/how-to-measure.jpg",
  "productIds": ["…"], "collectionIds": ["…"] }
```
  Rules: 1–12 columns (ar and/or en, ≤60), 1–40 rows, every row one cell per column (cells text ≤40), unit `cm`|`inch`, https image, products/collections must be the store's (422 otherwise).

### Storefront
- `GET /store/:ws/size-chart?productId=` → `{ sizeChart: { id, name, unit, columns, rows, note, imageUrl } | null }` (5-min cache).
  A chart attached to the product wins; else the newest chart on one of its collections.

### Screens
- Products → «جداول المقاسات» / "Size charts": list + editor (a grid: add/remove rows and columns, headings in ar/en, unit, note, picture, attach to products and/or collections).
- Product page (dashboard): which chart applies, «من مجموعة Tops» / "from collection Tops".
- Storefront product page: link «دليل المقاسات» / "Size guide" opening a sheet with the table in the shopper's language, a cm/inch switch (convert numeric cells ×/÷ 2.54, one decimal; leave text cells as they are), the note and picture.

## 211. Storefront search analytics and synonyms — UI: pending

### Storefront
- `GET /store/:ws/products?search=…` (first page) now also returns **`searchId`** (null on later pages) and, when the words
  found nothing but a synonym did, **`servedAs`** (the term searched instead).
- `POST /store/:ws/search/click` `{ searchId, productId }` → 204 — call when the shopper opens a result (first click counts, within an hour). Send `X-Visitor-Id` on the search to count searchers.
- When `servedAs` is set, show «نتايج عن "t-shirt"» / "Showing results for "t-shirt"".

### Staff — `/api/v1/workspaces/:ws/search-insights`
- `GET /?from=&to=` (`analytics.view`, default last 30 days) →
```json
{ "range": { "from": "…", "to": "…" },
  "totals": { "searches": 5, "searchers": 3, "noResults": 2, "clicks": 1, "clickRate": 33.3 },
  "topSearches": [{ "query": "shirt", "searches": 2, "avgResults": 1, "clicks": 1, "clickRate": 50, "servedAs": null }],
  "noResults": [{ "query": "jeans", "searches": 1, "lastAt": "…" }],
  "topClickedProducts": [{ "productId": "…", "name": "Demo T-Shirt", "clicks": 1 }] }
```
  (`clickRate` = clicks ÷ searches that had results, %.) Searches are kept 180 days.
- `GET /synonyms` (`products.view`) → `{ groups: [["تيشيرت", "t-shirt", "tee"]] }`; `PUT /synonyms` (`products.manage`) `{ groups }` — 2–10 terms per group (≤60 chars), ≤200 groups, a term in only one group (422).

### Screens
- Analytics → «البحث في المتجر» / "Store search": totals cards, top searches table (searches, results, clicks, rate), «بحث من غير نتايج» / "Searches with no results" with a quick «أضف مرادف» / "Add a synonym" action, top clicked products.
- Products → «مرادفات البحث» / "Search synonyms": groups of words as chips; hint «لو حد دوّر على كلمة ومالقاش، بنجرّب مرادفاتها» / "When a word finds nothing, we try its synonyms".

## Frontend request (2026-10-06): wishlist `available` for a whole product — done

`GET/POST /store/:ws/account/wishlist` → `items[].available` for an item saved **without** a variant is now true when **any**
active variant of the product can be bought (in stock, overselling, or inventory not tracked). An item saved with a variant
still reflects that variant only. The per-item product request can go.

## 212. Product questions and answers — UI: pending

### Storefront — `/api/v1/store/:ws/products/:productId/questions`
- `GET ?limit=20&offset=0` → `{ questions: [{ id, question, askerName, answer, answeredAt, createdAt }], total }` — published only, newest answers first (2-min cache).
- `POST` `{ question (5–1000), name?, email? (private, only to tell them about the answer), locale? }` → 201 `{ received: true, status: "pending" }`.
  429 after 5 questions an hour from one address. Nothing is shown before the store answers it.

### Dashboard — `/api/v1/workspaces/:ws/product-questions`
- `GET ?status=pending|published|hidden&productId=&limit=&offset=` (`products.view`) → `{ questions: [{ …, productId, productName, askerEmail, status, locale, answeredBy }], total, pending }`
- `PATCH /:id` (`products.manage`) `{ answer?, status? }` — an answer publishes by default; publishing without an answer → 422 `ANSWER_REQUIRED`. The first published answer emails the asker once (template `question_answered`, in their language).
- `DELETE /:id` → 204.
- New merchant notification type **`product.question`** (products.manage, bell on, email off by default): «سؤال جديد على …» / "New question on …", link `/products/:id?tab=questions`.

### Screens
- Product page (storefront): «أسئلة وأجوبة» / "Questions & answers" list + «اسأل سؤال» / "Ask a question" form (question, name, email optional «هنبلغك لما نرد» / "We'll tell you when we answer"); after sending: «وصلنا سؤالك، هيظهر بعد ما نرد عليه» / "Got it — it will appear once we answer".
- Dashboard: «الأسئلة» / "Questions" inbox (pending count badge, filters), answer box with «انشر» / "Publish" / «اخفي» / "Hide"; a «أسئلة» tab on the product page.

## 213. Licence keys for digital products — UI: pending (only the alert is new)

Already in the code from SPEC §18.2 (`modules/digital`): delivery type `license_codes`, pasting codes
(`POST /workspaces/:ws/digital/products/:id/codes`), listing and stock (`GET …/codes`), one code per unit drawn when an order is paid,
codes filled in later for paid orders that were waiting, and the codes on the download page and in the delivery email.

New:
- `GET /workspaces/:ws/digital/code-alerts` (`products.view`) → `{ lowAt: 5 }`; `PUT` (`products.manage`) `{ lowAt: 0–100000 }`.
- After a paid order draws codes, the team gets a `stock.low` notification (once a day per product): «طلبات مستنية أكواد: …» / "Orders waiting for codes: …" (`data.waitingCodes`) when the pool ran out, else «الأكواد قربت تخلص: …» / "Codes running low: …" when at most `lowAt` are left. Link `/catalog/:productId?tab=digital`.

Screen: digital product → Codes tab: «نبّهني لما يفضل» / "Warn me when … codes are left" (lowAt), and a red banner when `waitingCodes > 0` «في طلبات مستنية أكواد — أضف أكواد» / "Orders are waiting for codes — add codes".

## 214. Gift wrap and gift message — UI: pending

### Settings — `/api/v1/workspaces/:ws/gift-options` (read `products.view`, save `products.manage`)
- `GET` / `PUT` `{ enabled, wrapVariantId: uuid | null, messageMaxLength: 20–500 (default 300) }`.
  The wrap is a normal product the merchant creates and prices (e.g. "Gift wrap"), picked here; null = message only.

### Storefront
- `GET /store/:ws` → `store.giftOptions`: `null` when off, else `{ messageMaxLength, wrap: { variantId, name, priceAmount, currency, imageUrl } | null }`.
- Checkout body **`gift`**: `{ wrap?: true, message?: "…", hidePrices?: true }`. Wrap adds one line of the wrap product at its price (it shows in `order.items` and the total).
  422 on `gift`: "This store does not offer gift options" / on `gift.wrap`: not offered / not available / on `gift.message`: "At most N characters".
- The order keeps **`order.giftOptions`** `{ wrapped, message, hidePrices }` (null when not a gift).

### Screens
- Checkout: «ده هدية؟» / "Is this a gift?" toggle → «غلّفها كهدية (+20 ج.م)» / "Gift-wrap it (+EGP 20)", message box with counter «رسالة الإهداء» / "Gift message", «اخفي الأسعار في الشحنة» / "Hide prices in the parcel".
- Dashboard order page: a «هدية» / "Gift" badge, the message, and a "hide prices" note for whoever packs. The waybill prints "GIFT / هدية" and the message.
- Settings → «خيارات الهدايا» / "Gift options": toggle, wrap product picker, message length.

## 215. Mix-and-match box — UI: pending

Built on the existing quantity bundles (SPEC §10.1). A bundle now has **`mixAndMatch`**: when true, all the products attached
to it are priced **together** ("any 3 of these for EGP 400"), instead of each product on its own.

- `POST /workspaces/:ws/bundles` and `PATCH /:bundleId` accept `mixAndMatch: boolean` (default false). Responses include it. Products are attached as before (`PUT /:bundleId/products`).
  Use any tier type; "any N for a set price" = tier `{ quantity: N, discountType: "fixed_price", discountValue: <price> }`.
- Storefront: `GET /store/:ws/bundles/:bundleId/products` → `{ bundle: { id, name, displayStyle, mixAndMatch: true, tiers: [...] }, products: [{ id, name, slug, imageUrl, variants: [{ id, optionValues, priceAmount, currency, available }] }] }` (404 unless active and mix-and-match).
  The product payload's `bundle.mixAndMatch` says when a product belongs to such a box.
- The shopper adds the pieces as ordinary cart lines (or `item` + `extraItems` at checkout). The cart (`bundleDiscount`) and the order price them together. The order's discount snapshot entry has `mixAndMatch: true, productIds: [...]`.

### Screens
- Bundles editor: «اخلط واختار» / "Mix and match" toggle with the hint «المنتجات دي بتتحسب مع بعض: أي 3 منهم بسعر واحد» / "These products count together: any 3 of them for one price".
- Storefront: on a product in a box, a «كوّن البوكس بتاعك» / "Build your box" entry → box page listing the products (from the endpoint), slots «اختار 3» / "Pick 3" with a counter, «ضيف البوكس للسلة» / "Add box to cart" (adds the chosen variants as lines). Cart shows the box discount.

## 216. Holiday mode — UI: pending

### Settings — `/api/v1/workspaces/:ws/holiday-mode`
- `GET` (`orders.view`) → `{ enabled, mode: "pause"|"delay", from, until, shipsFrom, message: { ar, en } | null, activeNow }`
- `PUT` (`workspace.manage`) `{ enabled, mode, from?, until?, shipsFrom?, message? }` — dates ISO (null `from` = from now, null `until` = until switched off); `until` after `from` (422).

### Storefront
- `GET /store/:ws` → `store.holiday`: `null` normally, else `{ mode, until, shipsFrom, message }` while the holiday is on.
- **pause**: checkout answers **423 `STORE_ON_HOLIDAY`** with `error.details.holiday` (same object). The store, cart and pages keep working.
- **delay**: orders go through; the order gets the tag `holiday` and `shippingSnapshot.holiday = { shipsFrom, message }`.
- Orders entered in the dashboard are never blocked.

### Screens
- Settings → «وضع الإجازة» / "Holiday mode": toggle, choice «وقّف الطلبات» / "Pause orders" vs «اقبل الطلبات واشحن بعدين» / "Take orders, ship later", from/until dates, ships-from date (delay), message ar/en. Show «شغال دلوقتي» / "On now" when `activeNow`.
- Storefront: a banner with the message and date «المتجر في إجازة لحد 11 أكتوبر» / "We're on holiday until 11 October". Pause: disable checkout buttons «الطلبات موقوفة مؤقتًا» / "Orders are paused for now". Delay: on the product page, cart and checkout «الطلبات هتتشحن من 11 أكتوبر» / "Orders ship from 11 October".
- Dashboard order list: the `holiday` tag as a chip.

## 217. Sign in with Google (shopper accounts) — UI: pending

Uses Google's own "Sign in with Google" button (Google Identity Services); the button gives the browser an **ID token**.

### Storefront — `/api/v1/store/:ws/account/google`
- `GET` → `{ enabled, clientId }`: show the button only when `enabled` (shopper accounts on + Google on), and initialise it with `clientId`.
- `POST` `{ idToken }` → `{ token, expiresInSeconds, customer: { id, fullName, email } }`: the same `X-Shopper-Token` as a code sign-in.
  Errors: 404 `GOOGLE_SIGN_IN_OFF`; 401 `GOOGLE_TOKEN_INVALID` «تسجيل الدخول بجوجل منجحش — جرّب تاني» / "Google sign-in did not work — try again";
  422 `GOOGLE_EMAIL_UNVERIFIED`; 404 `ACCOUNT_NOT_FOUND` «مفيش حساب بالإيميل ده لسه — اطلب أو ادخل برقم موبايلك الأول» / "No account with this email yet — place an order or sign in with your phone first".
  It signs in to the store's existing contact with that (verified) email; it does not create one (a contact needs a phone).

### Dashboard — `/api/v1/workspaces/:ws/shopper-accounts/google` (`workspace.manage`)
- `GET` → `{ enabled, clientId, platformClientAvailable }`; `PUT` `{ enabled, clientId? }` — the store's own web client id (`…apps.googleusercontent.com`), needed for a custom domain. Empty = the platform's, when `platformClientAvailable`.

### Screens
- Settings → Customer accounts: «الدخول بحساب جوجل» / "Sign in with Google" toggle + client id field with a short guide link, and a note when the platform has none.
- Storefront sign-in sheet: the Google button above the phone/email code form.

## 218. VIP tiers — UI: pending

Customers move up by what they spent — or how many orders they placed — on **delivered** orders, over a window or ever.
Perks apply to **signed-in** shoppers (`X-Shopper-Token`) at checkout.

### Settings — `/api/v1/workspaces/:ws/vip-tiers`
- `GET` (`customers.view`) / `PUT` (`discounts.manage`):
```json
{ "enabled": true, "basis": "spent", "windowDays": 365,
  "tiers": [{ "id": "…", "name": { "ar": "ذهبي", "en": "Gold" }, "threshold": 500000, "percentOff": 10, "freeShipping": true, "pointsMultiplier": 2 }] }
```
  basis `spent` (threshold in minor units, net of refunds) or `orders` (count); windowDays 30–1825 or null (ever); ≤6 tiers with different thresholds; percentOff 0–50; pointsMultiplier 1–5. Enabled with no tiers → 422.
- `GET /customers/:customerId` (`customers.view`) → `{ tier | null, next: { id, name, missing } | null, standing: { basis, value, spent, orders } }`.

### Storefront
- `GET /store/:ws/account/vip` (X-Shopper-Token) → `{ enabled, basis, tier, next: { id, name, missing }, standing: { value }, tiers: [{ id, name, threshold, percentOff, freeShipping, pointsMultiplier }] }`.
- Checkout with `X-Shopper-Token`: plain lines priced `percentOff` lower (the lowest of normal, price list, VIP), free shipping when the tier has it, loyalty points × multiplier on delivery. Funnel checkouts keep their own prices. The shipping quote endpoint doesn't know the tier: show «شحن مجاني لعملاء VIP» / "Free shipping for VIP" from `/account/vip` instead.

### Screens
- Customers → «مستويات VIP» / "VIP tiers": basis switch «حسب المبلغ» / "By amount spent" / «حسب عدد الطلبات» / "By number of orders", window, tier rows (name ar/en, threshold, % off, free shipping, points ×).
- Customer page: tier badge + «فاضل 3 طلبات لـ Platinum» / "3 more orders to Platinum".
- Storefront account: «مستواك: ذهبي» / "Your level: Gold" with perks and progress to the next; checkout line «خصم VIP ‎10%» / "VIP 10% off".

## 219. Quote requests (B2B) — UI: pending

### Storefront — `/api/v1/store/:ws/quotes`
- `POST` `{ contact: { fullName, phone, email?, company? }, lines: [{ variantId, quantity (1–100000), note? }] (1–50), message? }` → 201 `{ quoteId, number: "Q-0001", token, status: "new" }`.
  **Keep `token`** (shown once): it opens the quote. Send `X-Shopper-Token` too when signed in (links the quote to the account). 429 after 5 an hour.
- `GET /:quoteId?token=` → `{ quote: { id, number, status: new|quoted|accepted|declined|cancelled|expired, contact: { fullName, company }, lines: [{ variantId, productName, sku, optionValues, quantity, requestedQuantity, note, listPrice, unitPrice, lineTotal }], message, quotedNote, totalAmount, currency, validUntil, orderId } }` (404 for a wrong token).
- `POST /:quoteId/accept` `{ token, shippingAddress: { country?, province, city, area?, addressLine, placeId? }, notes? }` → 201 `{ quote, orderId, orderNumber, totalAmount }`: a cash-on-delivery order at exactly the quoted prices (stock, shipping and fraud rules apply as usual).
  409 `QUOTE_EXPIRED` «عرض السعر انتهى — اطلب واحد جديد» / "This quote has expired — ask for a new one", 409 `QUOTE_NOT_OPEN`.
- `POST /:quoteId/decline` `{ token }`.

### Dashboard — `/api/v1/workspaces/:ws/quotes` (read `orders.view`, change `orders.manage`)
- `GET ?status=` → `{ quotes: [{ id, number, status, contact, lineCount, validUntil, orderId, createdAt }], newCount }`; `GET /:id` → `{ quote }` with the full contact.
- `PUT /:id/answer` `{ lines: [{ variantId, quantity, unitPrice }], note?, validUntil (future) }` → quoted; only requested products (422). The first answer emails the shopper a link «عرض السعر جاهز» / "Your quote is ready" pointing at `/quotes/:id` on the store (the page asks for the token kept by the shopper's browser, or the shopper signs in).
- `POST /:id/cancel`.
- New merchant notification type **`quote.request`** (orders.view, bell + email).
- Accepted orders carry the tag `quote` and the note "Quote Q-0001". For online payment, the team sends the existing payment link from the order.

### Screens
- Product page / cart: «اطلب عرض سعر» / "Request a quote" (quantities per variant, company, message). After sending: «وصلنا طلبك، هنرد عليك بعرض سعر» / "We got it — we'll send you a quote".
- Storefront `/quotes/:id`: status, the store's prices vs list prices, total, validity «صالح لحد …» / "Valid until …", buttons «موافق — اطلب» / "Accept and order" (address form) and «رفض» / "Decline".
- Dashboard → Orders → «عروض الأسعار» / "Quotes": inbox with the new count, editor to set the unit price/quantity per line, note and validity, «ابعت العرض» / "Send quote"; link to the order once accepted.

## 220. Shopper self-service on orders — UI: pending

### Settings — `/api/v1/workspaces/:ws/order-self-service` (`orders.manage`)
- `GET` / `PUT` `{ cancel: { enabled, minutes: 5–10080 | null }, address: { enabled, minutes | null } }` — minutes after placing the order (null = until it ships).

### Storefront — `/api/v1/store/:ws/orders/:orderId/self-service`
Proof of ownership: `X-Shopper-Token` of the order's customer, **or** the order's tracking token (`?token=` on GET, `token` in the body on POST — the same token as the tracking link).
- `GET` → `{ canCancel, canChangeAddress, cancelUntil, addressUntil }`.
- `POST /cancel` `{ token?, reason? }` → `{ cancelled: true }` — goes through the store's normal cancellation (stock released, courier booking cancelled). Allowed while not shipped, not cancelled, not paid online, and not yet confirmed by the store; else 409 `CANCEL_NOT_ALLOWED` «مينفعش تلغي الطلب من هنا دلوقتي — كلّم المتجر» / "This order can no longer be cancelled here — contact the store".
- `POST /address` `{ token?, address: { province, city, area?, addressLine, placeId?, country? } }` → `{ shippingAddress, note }` — while not shipped or cancelled; places the store doesn't deliver to are refused as at checkout. 409 `ADDRESS_CHANGE_NOT_ALLOWED`. The shipping price is not recalculated (the store confirms any difference).
- The team gets a notification for each (type `order.new`, `data.by: "customer"`).

### Screens
- Settings → Orders: «العميل يقدر يلغي الطلب» / "Customers can cancel" + minutes; «العميل يقدر يغيّر العنوان» / "Customers can change the address" + minutes.
- Tracking page / account order page: buttons «إلغاء الطلب» / "Cancel order" (reason, confirm) and «تغيير العنوان» / "Change address" (address form), shown from `canCancel` / `canChangeAddress`, with «متاح لحد 3:15 م» / "Available until 3:15 PM" from the `…Until` fields.

## 221. Delivery date and time slots — UI: pending

### Settings — `/api/v1/workspaces/:ws/delivery-slots` (read `orders.view`, save `workspace.manage`)
- `GET` / `PUT` body:
  ```json
  { "enabled": true, "required": true, "leadDays": 1, "cutoffTime": "18:00", "sameDayNoticeMinutes": 120, "horizonDays": 7,
    "weekly": { "0": [{ "id": "morning", "from": "10:00", "to": "14:00", "capacity": 20 }, { "from": "16:00", "to": "20:00", "capacity": null }], "5": [] },
    "closedDates": ["2026-10-08"], "note": { "ar": "التوصيل من 10 الصبح", "en": "Delivery from 10am" } }
  ```
- `weekly` keys `"0"`–`"6"` (0 = Sunday), up to 12 slots a day; `from`/`to` `HH:MM` store time, `to` after `from` (422 `weekly.<day>.<i>.to`); `capacity` 1–10000 or null (unlimited). A slot without `id` gets one (send it back unchanged on later saves, so booked orders keep pointing at it). `leadDays` 0–30 (0 = same day), `cutoffTime` `HH:MM` or null (after it, the earliest day moves one day later), `sameDayNoticeMinutes` 0–1440, `horizonDays` 1–60, `closedDates` `YYYY-MM-DD` list.
- `GET /schedule?from=YYYY-MM-DD&to=YYYY-MM-DD` (≤ 62 days) → `{ days: [{ date, slots: [{ slotId, from, to, orders: [{ id, orderNumber, totalAmount, currency, customerName }] }] }] }` — cancelled orders left out.
- `PUT /orders/:orderId` (`orders.manage`) `{ date, slotId, force? }` moves an order; `{ date: null }` removes its slot. 409 `DELIVERY_SLOT_FULL` unless `force: true` → `{ deliverySlot }`.

### Storefront
- `GET /api/v1/store/:ws/delivery-slots` → 404 when off, else
  `{ required, note, timezone, days: [{ date: "2026-10-09", weekday: 5, slots: [{ id, from, to, available }] }] }` (only days with slots; full slots come back `available: false` — show them disabled).
- Checkout body: `deliverySlot: { date, slotId }`. Errors: 422 `deliverySlot` «اختار يوم وميعاد التوصيل» / "Choose a delivery day and time" (when `required`); 409 `DELIVERY_SLOT_UNAVAILABLE` «الميعاد ده مش متاح — اختار ميعاد تاني» / "This delivery time isn't offered — choose another"; 409 `DELIVERY_SLOT_FULL` «الميعاد ده اتحجز بالكامل — اختار ميعاد تاني» / "This delivery time is fully booked — choose another" (reload the slots).
- The order carries `shippingSnapshot.deliverySlot = { date, slotId, from, to }`; the waybill prints «DELIVER ON / التوصيل: 2026-10-09 10:00-14:00».

### Screens
- Settings → Shipping → «مواعيد التوصيل» / "Delivery times": on/off, required, earliest day («أقرب يوم: بكرة» / "Earliest: tomorrow"), cutoff time, days ahead, a weekly grid of slots with capacity («عدد الطلبات في الميعاد» / "Orders per slot", empty = unlimited), closed days calendar, note (ar/en).
- Checkout: day chips («الخميس 9 أكتوبر») then slot chips («10:00 – 14:00»), full ones disabled «محجوز» / "Full"; the note under them.
- Order page: «ميعاد التوصيل» / "Delivery time" with «تغيير» / "Change" (day + slot, confirm «الميعاد مليان — احجز برضه؟» / "This slot is full — book anyway?" → `force`).
- Orders → «جدول التوصيل» / "Delivery schedule": per day and slot, the orders booked, count vs capacity.
- Thank-you page / tracking page: «هيوصلك يوم الخميس 9 أكتوبر بين 10:00 و 14:00» / "Arriving Thursday 9 October, 10:00–14:00".

## 222. Customer referral program (invite a friend) — UI: pending

### Settings — `/api/v1/workspaces/:ws/customer-referrals` (read `customers.view`, save `discounts.manage`)
- `GET` / `PUT`:
  ```json
  { "enabled": true, "friend": { "percentOff": 10, "freeShipping": false },
    "referrer": { "type": "store_credit", "amount": 5000 }, "minOrderAmount": null, "maxRewardsPerReferrer": 20 }
  ```
  `percentOff` 0–50; when enabled the friend needs a percent off or free shipping (422 `friend`). `referrer.type` `store_credit` (amount in minor units) or `points` (needs loyalty on, else 422 `referrer.type`). `minOrderAmount` minor units or null; `maxRewardsPerReferrer` 1–1000 or null.
- `GET /list?status=pending|rewarded|void&customerId=&limit=&offset=` → `{ referrals: [{ id, status, voidReason, reward, rewardedAt, createdAt, order: { id, orderNumber, totalAmount, currency }, referrer: { id, name }, friend: { id, name } }], total }`. `voidReason`: `cancelled`, `returned`, `below_minimum`, `limit_reached`, `program_off`.

### Storefront
- `GET /api/v1/store/:ws/account/referral` (X-Shopper-Token; 401 `SHOPPER_NOT_SIGNED_IN`) → `{ enabled: false }` or
  `{ enabled: true, code: "Y45IFBG", path: "/?ref=Y45IFBG", offer: { friend, referrer, minOrderAmount }, stats: { pending, rewarded }, referrals: [{ id, status, reward, rewardedAt, createdAt }] }` (friends are not named to the inviter).
- `GET /api/v1/store/:ws/referrals/:code` → `{ valid: true, code, friend: { percentOff, freeShipping } }` or `{ valid: false }` — for the banner when a visitor lands with `?ref=`. Keep the code (e.g. localStorage) and send it at checkout.
- Checkout body: `referralCode: "Y45IFBG"`. Refusals are 422 on `referralCode`: «كود الدعوة مش صحيح» / "This invite code is not valid"; «مينفعش تستخدم دعوتك لنفسك» / "You can't use your own invite"; «الدعوة لأول طلب بس في المتجر» / "Invites are for a first order in this store"; «المتجر مفيهوش برنامج دعوات» / "This store has no invite program". On a refusal, offer to place the order without the code.
- The friend's percent off is applied to plain lines' prices (like VIP), free shipping on the order. The order gets the tag `referral`. The inviter is rewarded when the friend's order is delivered; a cancelled or returned order cancels the invite.

### Screens
- Marketing → «ادعي صاحبك» / "Refer a friend": on/off, friend's offer (percent / free shipping), inviter's reward (store credit amount or points), minimum order, max rewards per customer; a table of invites with status chips «مستني التوصيل» / "Waiting for delivery", «اتكافئ» / "Rewarded", «اتلغى» / "Cancelled".
- Customer page: their invites (`list?customerId=`).
- Storefront account → «ادعي صحابك» / "Invite friends": the link to copy/share (WhatsApp share link by the shopper themself), «صاحبك ياخد خصم 10% على أول طلب، وانت تاخد 50 جنيه رصيد لما يوصله» / "Your friend gets 10% off their first order; you get EGP 50 credit once it's delivered", counts and list.
- Landing banner on `?ref=`: «معاك دعوة! خصم 10% على أول طلب» / "You've been invited! 10% off your first order".
- Checkout: show the invite as applied, with its error messages.

## 223. Frequently bought together — UI: pending

The storefront strip already exists: `GET /api/v1/store/:ws/cross-sell?productIds=a,b&placement=` → `{ source: "rule" | "bought_together" | null, ruleId, products: [public products] }`. New in this item:
- **`placement=product`** for the product page (send the page's product id). Merchant rules (Offers → Cross-sell, `POST/PATCH /workspaces/:ws/offers/cross-sell`) accept `placement: "product"` too — those are the merchant's **pins**: a matching rule wins over the computed list.
- The computed list now comes from pairs worked out **nightly** (and right after a settings save), with a minimum number of shared orders and the merchant's **exclusions**.

### Settings — `/api/v1/workspaces/:ws/bought-together` (read `products.view`, change `products.manage`)
- `GET` → `{ enabled, windowDays, minOrders, excludedProductIds, pairs, computedAt }`.
- `PUT` `{ enabled, windowDays: 30–1095 (365), minOrders: 1–100 (1), excludedProductIds: [uuid] (≤ 500, this store's; else 422) }` → settings + `pairs` (recomputed at once). `enabled: false` = the computed list is off (merchant rules still show).
- `POST /recompute` → `{ pairs }`.
- `GET /products/:productId` → `{ products: [{ productId, name, orders, excluded }] }` — what this product is bought with and in how many orders.

### Screens
- Product page (storefront): «بيتشروا مع بعض» / "Frequently bought together" strip from `placement=product`, add-to-cart per product (or all), hidden when `products` is empty.
- Cart: the existing strip (placement `cart`) now honours the exclusions.
- Dashboard product page → «بيتشري مع» / "Bought with": the list with order counts («في 12 طلب» / "in 12 orders"), a toggle «متقترحوش» / "Don't suggest" (adds to `excludedProductIds`), and a link «ثبّت منتجات» / "Pin products" to a cross-sell rule with placement "product".
- Settings → Offers → «بيتشروا مع بعض» / "Bought together": on/off, «آخر كام يوم» / "Look back (days)", «أقل عدد طلبات مشتركة» / "Minimum shared orders", excluded products, «آخر تحديث» / "Last updated" (`computedAt`) and «حدّث دلوقتي» / "Update now".

## 224. Stock forecast — UI: pending

### `/api/v1/workspaces/:ws/stock-forecast` (read `inventory.view`, change `inventory.manage`)
- `GET ?status=out|reorder_now|soon|ok|no_sales|needs_order&productId=&limit=` (limit ≤ 1000, default 200) →
  ```json
  { "settings": { "windowDays": 30, "leadTimeDays": 7, "coverDays": 30, "safetyDays": 7 },
    "counts": { "reorder_now": 3, "ok": 40, "no_sales": 12 }, "total": 3,
    "variants": [{ "variantId": "…", "productId": "…", "productName": "ZZ Mug", "sku": "ZZMUG", "optionValues": {},
      "available": 6, "incoming": 0, "soldInWindow": 6, "perDay": 0.2, "daysLeft": 30,
      "runsOutOn": "2026-11-05", "reorderBy": "2026-10-22", "suggested": 3, "unitCost": "4000", "status": "ok" }] }
  ```
  Most urgent first. `needs_order` = `suggested > 0`. `daysLeft`, `runsOutOn` and `reorderBy` are null without sales. Only stock-tracked, non-archived products.
- `PUT /settings` `{ windowDays 7–180, leadTimeDays 0–180, coverDays 1–365, safetyDays 0–90 }` (all required).
- `POST /purchase-order` `{ supplierId, locationId?, expectedAt?, note?, lines: [{ variantId, quantity?, unitCost? }] }` → 201 the draft purchase order (same shape as `GET /purchasing/purchase-orders/:id`). A line without `quantity` takes `suggested`, and without `unitCost` takes the variant's cost. 422 `lines.N.quantity` «مفيش حاجة تتطلب للصنف ده — اكتب كمية» / "Nothing to order for this one — type a quantity"; 422 `lines.N.variantId` for a product that isn't stock-tracked or isn't this store's.

### Screens
- Inventory → «توقّع المخزون» / "Stock forecast":
  - Filter chips with counts: «خلص» / "Out", «اطلب دلوقتي» / "Reorder now", «قرّب يخلص» / "Running low", «تمام» / "OK", «مفيش مبيعات» / "No sales", «محتاج طلب» / "Needs ordering".
  - Table columns: product/variant, available, incoming «جاي في الطريق», per day «بيتباع في اليوم», days left «يكفي كام يوم», «هيخلص يوم», «اطلب قبل», suggested quantity (editable).
  - Row checkboxes, then «اعمل أمر شراء» / "Create purchase order": pick the supplier (and location), then open the new draft PO.
- Settings dialog: «احسب المبيعات من آخر … يوم» / "Sales over the last … days", «المورّد بيوصّل في … يوم» / "Supplier lead time (days)", «عايز المخزون يكفي … يوم» / "Stock to cover (days)", «هامش أمان … يوم» / "Safety margin (days)".
- Product page in the dashboard: a small card from `?productId=` («يكفي 30 يوم — اطلب قبل 22 أكتوبر» / "30 days left — reorder by 22 Oct").

## 225. Click and collect — UI: pending

### Settings — `/api/v1/workspaces/:ws/click-and-collect` (read `orders.view`, save `shipping.manage`)
- `GET` / `PUT` `{ enabled, locations: { "<stockLocationId>": { enabled, instructions: { ar, en } | null, hours: { ar, en } | null } } }` — texts ≤ 300; locations must be this store's (Inventory → Locations, item 206); when enabled at least one location must be on (422 `locations`).

### Orders — same base
- `GET /orders?status=pending|ready|collected|cancelled&locationId=&limit=&offset=` → `{ total, pickups: [{ orderId, status, location: { id, name, address, instructions, hours }, readyAt, collectedAt, order: { id, orderNumber, totalAmount, currency, customerName, phone, paymentMethod, financialState, createdAt } }] }`.
- `POST /orders/:orderId/ready` (`orders.manage`) → `{ pickup, emailed }` — emails the shopper «طلبك … جاهز للاستلام» with the place and the code (when the order has an email). 409 `PICKUP_NOT_PENDING`, `ORDER_CANCELLED`.
- `POST /orders/:orderId/collect` `{ code: "713997" }` → `{ pickup }` — the order becomes delivered (fulfilled; loyalty, referrals, gift cards and automations run as for a delivery). 422 `PICKUP_CODE_WRONG` «الكود غلط» / "Wrong code"; 409 `PICKUP_NOT_OPEN`.

### Storefront
- `GET /api/v1/store/:ws/pickup/locations?variantIds=a,b` → 404 when off, else `{ locations: [{ id, name, address, instructions, hours, available }] }` (`available` = every given variant has a free unit there; null without `variantIds`).
- Checkout body: `pickupLocationId` instead of `shippingAddress` (any address sent is dropped; address fields of the checkout form aren't required; shipping is 0; `shippingOption` ignored). Errors: 422 `pickupLocationId` «الاستلام مش متاح من المكان ده — اختار مكان تاني» / "Pickup isn't offered at this place — choose another"; 409 `PICKUP_OUT_OF_STOCK` `{ variantIds }` «في منتجات مش موجودة في الفرع ده — اختار فرع تاني أو التوصيل» / "Some items aren't available at this place — choose another place or delivery".
- The 201 checkout response carries `pickup: { code, location }`. The order has the tag `pickup` and `shippingSnapshot.pickup = { locationId, name, address }`.
- `GET /api/v1/store/:ws/pickup/orders/:orderId?token=<tracking token>` (or `X-Shopper-Token`) → `{ pickup: { orderId, status, location, readyAt, collectedAt, code } }` (`code` null once collected or cancelled).

### Screens
- Settings → Shipping → «الاستلام من الفرع» / "Store pickup": on/off, per location a toggle, instructions and opening hours (ar/en).
- Checkout: a choice «توصيل» / "Delivery" vs «استلام من الفرع» / "Pick up in store"; for pickup a list of places (address, hours, unavailable ones disabled «مش متوفر هنا» / "Not available here") and no address form; shipping shows «مجانًا» / "Free".
- Thank-you / tracking page: «كود الاستلام: 713997» / "Pickup code: 713997" big, the place, hours and instructions, status «بنجهّز طلبك» / "Preparing" → «جاهز للاستلام» / "Ready for pickup" → «اتسلّم» / "Collected".
- Dashboard → Orders → «طلبات الاستلام» / "Pickups": tabs by status and a location filter; «جاهز» / "Mark ready"; «تسليم» / "Hand over" opens a code field (6 digits) and confirms. The order page shows the pickup block instead of the address.

## Frontend request (2026-10-07): `lockFunnels` in the public gate view — done

- `GET /api/v1/store/:ws` → `store.gate` now carries `lockFunnels: boolean`: `{ mode, message, opensAt, lockFunnels, ageCheck }`. The 423 `STORE_LOCKED` error's `details.gate` has it too (same view).
- Storefront: on funnel pages, show the gate only when `gate.mode !== 'off' && gate.lockFunnels`; no extra funnel request needed.

## 226. Pick list — UI: pending

### `POST /api/v1/workspaces/:ws/orders/documents/pick-list?as=json|pdf|base64` (`orders.view`)
- Body: either `{ orderIds: [uuid] }` (1–500, cancelled ones skipped) **or** `{ readyToShip: true }` (every order at stage `ready_to_ship`, oldest first, up to 500); optional `locationId` keeps only the orders that location ships. Sending both or neither → 422. Nothing to pick → 422 `NO_ORDERS_SELECTED`.
- `as=json` (default) →
  ```json
  { "orderCount": 3, "unitCount": 6,
    "locations": [{ "locationId": null, "name": null,
      "lines": [{ "variantId": "…", "productId": "…", "name": "ZZ Pick Socks", "options": {}, "sku": "ZZ-SOCK", "imageUrl": null,
                  "quantity": 3, "orders": [{ "orderId": "…", "orderNumber": "ORD-…", "quantity": 2 }] }] }] }
  ```
  Locations as the orders are assigned (item 206); `locationId: null` = the store's main stock when it has no locations. Lines sorted by SKU, then name.
- `as=pdf` → `application/pdf` (A4: tick box, quantity, name — options, SKU, the orders); `as=base64` → `{ filename, contentType, base64, orderCount }` for the dashboard's request helper.

### Screens
- Orders list: in the bulk actions next to «طباعة البوالص» / "Print waybills", add «قائمة التجهيز» / "Pick list" for the selected orders. In the "Ready to ship" tab add a button «جهّز كل الجاهز للشحن» / "Pick everything ready to ship".
- A pick-list view (or the PDF): per location «المخزن الرئيسي» / "Main stock", rows «3 × ZZ Pick Socks — ZZ-SOCK» with the order numbers under each, checkboxes, and «اطبع» / "Print".

## 227. Scheduled price changes (sales with a start and an end) — UI: pending

### `/api/v1/workspaces/:ws/price-schedules` (read `products.view`, change `products.manage`)
Body for create / edit / preview:
```json
{ "name": "Weekend sale", "startsAt": "2026-10-09T08:00:00Z", "endsAt": "2026-10-11T22:00:00Z",
  "target": { "type": "products", "ids": ["…"] },
  "change": { "mode": "percent_off", "value": 20 }, "showWasPrice": true }
```
- `target.type`: `variants` | `products` | `collection` (exactly one id), ids of this store (422). `change.mode`: `percent_off` (1–90), `amount_off` (minor units), `set_price` (minor units). `endsAt` null = no end; must be after `startsAt` and in the future (422 `endsAt`).
- `GET ?status=scheduled|active|ended|cancelled` → `{ schedules: [{ id, name, status, startsAt, endsAt, target, change, showWasPrice, appliedAt, revertedAt, createdAt }] }`.
- `POST /preview` → `{ total, variants: [{ variantId, productName, sku, options, price, salePrice }] }` (up to 500 shown).
- `POST /` → 201 `{ schedule }` (with `items` once started — a start time in the past starts it at once).
- `GET /:id` → `{ schedule }` with `items: [{ variantId, productName, sku, options, oldPrice, newPrice, state }]`. `state`: `applied`, `restored`, `kept` (the team changed the price during the sale, so it was left), `skipped` (already in another running sale, or no change).
- `PUT /:id` — only while `scheduled` (409 `PRICE_SCHEDULE_LOCKED`).
- `POST /:id/stop` — scheduled → `cancelled`; active → `ended` now with prices back; else 409 `PRICE_SCHEDULE_OVER`.
- How it works: at the start the variants' real price changes (so the cart, checkout, feeds and pixels all agree), with the price before the sale as the compare-at "was" price when `showWasPrice`; at the end the old price and compare-at come back. Switching happens every minute.

### Screens
- Products → «التخفيضات المجدولة» / "Scheduled sales": list with status chips «مستني» / "Scheduled", «شغال» / "Running", «خلص» / "Ended", «اتلغى» / "Cancelled".
- Editor: name, what's on sale («منتجات» / "Products", «أصناف» / "Variants", «تشكيلة» / "Collection" pickers), «خصم %» / "% off", «خصم مبلغ» / "Amount off", «سعر ثابت» / "Set price", start / end date-time (store time), «اعرض السعر القديم مشطوب» / "Show the old price crossed out", and the preview table (price → sale price).
- Detail: per variant old → new and state; «وقّف التخفيض» / "Stop sale" (confirm «الأسعار هترجع زي ما كانت» / "Prices go back now"), «إلغاء» / "Cancel" before it starts.
- Product page in the dashboard: a note when the variant is in a running sale «في تخفيض لحد …» / "On sale until …".

## 228. Business customers (company, tax ID, tax exemption) — UI: pending

### Dashboard — `/api/v1/workspaces/:ws/customers/:customerId/business` (read `customers.view`, change `customers.manage`)
- `GET` → `{ companyName, taxId, taxExempt, taxExemptNote }`.
- `PUT` any of `{ companyName ≤ 200, taxId ≤ 40, taxExempt: boolean, taxExemptNote ≤ 300 }` (empty string = clear) → the same.

### Storefront — `/api/v1/store/:ws/account/business` (X-Shopper-Token; 401 `SHOPPER_NOT_SIGNED_IN`)
- `GET` → `{ companyName, taxId, taxExempt }`; `PUT { companyName?, taxId? }` → the same. Changing the tax ID of an exempt customer turns the exemption off until the store checks it again.

### Behaviour
- Only the store sets `taxExempt`. It applies to an order placed by that customer **signed in** (checkout with X-Shopper-Token, order under their phone), or entered by the team for them. A guest checkout with the same phone is taxed. Exempt = no tax added (a price that includes tax is not lowered).
- The order's `contactSnapshot` carries `company`, `taxId` and `taxExempt: true` when they apply; the invoice prints them under "Bill to" («Tax ID: …», «Tax exempt / معفى من الضريبة»).

### Screens
- Customer page → «بيانات الشركة» / "Business details": company, tax ID, toggle «معفى من الضريبة» / "Tax exempt" with a note («شوفت شهادة الإعفاء رقم …» / "Exemption certificate seen").
- Storefront account → «بيانات الشركة» / "Company details": company name «اسم الشركة», tax ID «الرقم الضريبي», and a badge «معفى من الضريبة» / "Tax exempt" when set.
- Checkout (signed in, exempt): the tax line shows «معفى» / "Exempt"; order page / invoice: company and tax ID under the customer.

## 229. Pay later on account (net terms) — UI: pending

### Dashboard — `/api/v1/workspaces/:ws/account-credit`
- `GET /customers/:customerId` (`customers.view`) → statement:
  ```json
  { "enabled": true, "creditLimit": "60000", "paymentTermsDays": 30, "owed": "25000", "overdue": "0", "available": "35000",
    "orders": [{ "id": "…", "orderNumber": "ORD-…", "totalAmount": "25000", "amountPaid": "0", "due": "25000", "currency": "EGP",
                 "financialState": "pending", "paymentDueAt": "2026-11-05T…", "overdue": false, "createdAt": "…" }] }
  ```
- `PUT /customers/:customerId` (`customers.manage`) `{ enabled, creditLimit: minor units | null (no limit), paymentTermsDays: 0–365 (30) }` → statement.
- `GET ?overdue=true` (`customers.view`) → `{ customers: [{ id, fullName, companyName, creditLimit, paymentTermsDays, owed, overdue, nextDueAt }] }` (approved customers, or anyone with on-account orders; most overdue first).
- `POST /orders/:orderId/payments` (`orders.manage`) `{ amount, reference?, paidAt? }` → 201 `{ paymentId, amountPaid, due }`. More than is due → 422 `amount`; not an on-account order → 409 `NOT_ON_ACCOUNT`; cancelled → 409. The order turns `partially_paid` / `paid`.

### Checkout
- New payment method **`on_account`**: only for a signed-in shopper (X-Shopper-Token) the store approved, ordering under their own phone. Errors: 401 `SHOPPER_NOT_SIGNED_IN` «سجّل دخول عشان تدفع آجل» / "Sign in to pay later on account"; 422 `paymentMethod` «الدفع الآجل مش متاح للحساب ده» / "Paying later isn't open for this account"; 422 `CREDIT_LIMIT_EXCEEDED` `{ creditLimit, owed, available }` «الطلب أكبر من الرصيد المتاح (متاح: 350 ج)» / "This order is more than your available credit (available: EGP 350)".
- The order: `paymentMethod: "on_account"`, `paymentDueAt` (terms days later), ships like cash on delivery (ready to ship, courier booking allowed) but the courier collects nothing; the waybill says «ON ACCOUNT — DO NOT COLLECT». Staff can create manual orders with `on_account` for an approved customer.
- `GET /api/v1/store/:ws/account/on-account` (X-Shopper-Token) → `{ enabled: false }` or the statement above.

### Screens
- Customer page → «الدفع الآجل» / "Pay on account": toggle, credit limit «حد الائتمان», terms «يدفع خلال … يوم» / "Pays within … days", owed / overdue / available, the orders with due dates (overdue in red «متأخر» / "Overdue"), and «سجّل دفعة» / "Record payment" (amount, reference) per order.
- Customers → «حسابات الآجل» / "On-account balances": the list with owed / overdue / next due date, filter «المتأخرين بس» / "Overdue only".
- Checkout (signed-in approved shopper): a method «ادفع آجل (خلال 30 يوم)» / "Pay later on account (30 days)" with «المتاح: …» / "Available: …".
- Storefront account → «حسابي الآجل» / "My account balance": owed, available, orders with due dates.

## 230. Stock lots with expiry dates — UI: pending

### `/api/v1/workspaces/:ws/stock-lots` (read `inventory.view`, change `inventory.manage`)
- `GET ?variantId=&status=active|expiring|expired|empty&withinDays=&limit=` → `{ alertDays, lots: [{ id, variantId, productName, sku, locationId, lotCode, expiresOn, quantityReceived, quantityRemaining, purchaseOrderId, note, writtenOffAt, expired, createdAt }] }` — first expiring first. `expiring` = not expired and within `withinDays` (default the alert days).
- `POST /` `{ variantId, lotCode ≤ 60, expiresOn: "YYYY-MM-DD" | null, quantity, addToStock = true, locationId?, purchaseOrderId?, note? }` → 201 `{ lot }`. `addToStock: true` adds the units to stock; `false` only labels units already on hand (422 `quantity` «فيه بس N قطعة من غير دفعة» / "Only N units are on hand without a lot").
- `PATCH /:lotId` `{ lotCode?, expiresOn?, note? }`.
- `POST /:lotId/write-off` `{ quantity?, reason? }` → `{ lot, writtenOff }` — the units leave stock (all that's left when no quantity). 422 `LOT_NOT_ENOUGH`.
- `PUT /settings` `{ alertDays: 1–365 }` (default 30).
- Automatic: when an order ships (or is delivered/collected without a shipment) its units come off the lots, first expiring first, once per order. A daily check sends the bell/email notification **`stock.lot_expiring`** «N دفعة قربت تنتهي صلاحيتها» once per lot.
- Pick list (item 226): each line now has `lots: [{ lotId, lotCode, expiresOn, take, expired }]` and the PDF prints «LOT A-10 exp 2026-10-16: 5 · LOT B-60 …: 2».

### Screens
- Inventory → «الدفعات والصلاحية» / "Lots & expiry": tabs «شغالة» / "Active", «قربت تنتهي» / "Expiring soon", «منتهية» / "Expired", «خلصت» / "Used up"; columns product, lot, expiry (red when expired), remaining / received.
- «استلام دفعة» / "Receive a lot": product, lot code, expiry date, quantity, location, «ضيفها للمخزون» / "Add to stock" (off = label existing stock), link to a purchase order.
- Row actions: edit, «إعدام / شطب» / "Write off" (quantity, reason) with confirm «الكمية دي هتخرج من المخزون» / "These units leave stock".
- Product variant page: its lots (first to go first). Pick list view: the lot to take under each line.
- Settings: «نبّهني قبل الانتهاء بـ … يوم» / "Warn me … days before expiry".

## 231. Product specifications and comparison — UI: pending

### Dashboard — `/api/v1/workspaces/:ws/product-specs` (read `products.view`, change `products.manage`)
- `GET /keys` → `{ keys: [{ id, name: { ar, en }, unit, filterable, position }] }`.
- `POST /keys` `{ name: { ar?, en? } (one required, ≤ 60), unit? ≤ 20, filterable = false, position = 0 }` → 201 `{ key }` (≤ 100 keys). `PUT /keys/:keyId` same body. `DELETE /keys/:keyId` → 204 (its values go too).
- `GET /keys/:keyId/values` → `{ values: [{ value, products }] }` (suggestions while typing).
- `GET /products/:productId` → `{ values: { "<keyId>": "128" } }`; `PUT /products/:productId` `{ values: { "<keyId>": "value ≤ 200" | "" } }` replaces them all (empty = none); unknown key → 422.

### Storefront — `/api/v1/store/:ws/specs`
- `GET /products/:productId` → `{ specs: [{ id, name, unit, filterable, position, value }] }` (only keys with a value, store order).
- `GET /filters?collectionId=` → `{ filters: [{ id, name, unit, values: [{ value, products }] }] }` (filterable keys, active products).
- `GET /products?f=<keyId>:<value>&f=…&collectionId=&page=&limit≤48` → `{ products: [public products], total, page, limit }` — values of one key are OR, different keys AND.
- `GET /compare?productIds=a,b,c` (2–4) → `{ keys: [{ id, name, unit, differs }], products: [{ product, values: { keyId: value } }] }`; else 422.

### Screens
- Settings → Products → «المواصفات» / "Specifications": list of keys (name ar/en, unit «الوحدة», «فلتر في المتجر» / "Use as a store filter", order), add / edit / delete.
- Product editor → «المواصفات» / "Specifications": one field per key with suggestions from `/values`.
- Product page: a «المواصفات» / "Specifications" table (value + unit), and «قارن» / "Compare" (adds to a compare tray kept in the browser, max 4).
- Collection / search pages: filter panel from `/filters` (checkbox values with counts), results from `/products?f=…`.
- Compare page: products as columns, keys as rows, «اعرض الاختلافات بس» / "Show differences only" (uses `differs`), add to cart per column.

## 232. URL redirects — UI: pending

### Dashboard — `/api/v1/workspaces/:ws/redirects` (`website.edit`)
- `GET ?q=&source=manual|auto|import&limit=&offset=` → `{ redirects: [{ id, fromPath, toPath, statusCode, source, hits, lastHitAt, createdAt }], total }`.
- `POST /` `{ fromPath: "/old-page", toPath: "/new-page" | "https://…", statusCode: 301 | 302 (301) }` → 201 `{ redirect }`. Paths start with `/` (a trailing slash is dropped; a query is kept). 422: `fromPath` «المسار ده عليه تحويل بالفعل» / "This path already redirects"; `toPath` «مينفعش يحوّل لنفسه» / "A redirect cannot point at itself", «ده هيعمل لفة مقفولة» / "This would send shoppers round in a loop"; an `http://` target is refused (https only).
- `PUT /:id` same body; `DELETE /:id` → 204.
- `POST /import` `{ csv: "from,to[,301|302]\n/old,/new" }` (≤ 5000 lines, header optional) → `{ created, updated, errors: [{ line, message }] }`.
- Automatic (source `auto`): when a product slug changes, `/products/<old>` → `/products/<new>`; a collection slug change, `/products?collection=<old>` → `…=<new>`. Older redirects to the old address are pointed at the new one; a redirect away from the new address is removed.

### Storefront
- `GET /api/v1/store/:ws/redirects/lookup?path=/old-page` → `{ to, statusCode }` or 404. Call it on the not-found page (and for a product/collection slug that returns 404), then redirect (Next.js `permanentRedirect` for 301, `redirect` for 302). Hits are counted.

### Screens
- Settings → Website → «تحويل الروابط» / "URL redirects": table (from → to, type «دائم 301» / "Permanent", «مؤقت 302» / "Temporary", source chip «تلقائي» / "Automatic", hits «عدد الزيارات»), search, add / edit / delete, «استيراد CSV» / "Import CSV" with the error lines shown.

## 233. Store locator (branches) — UI: pending

### Dashboard — `/api/v1/workspaces/:ws/store-locator` (`website.edit`)
- `GET` / `PUT` `{ enabled, branches: { "<stockLocationId>": { visible, phone?, whatsapp?, hours: { ar, en }?, note: { ar, en }?, lat?, lng? } } }` — branches are the store's stock locations (Inventory → Locations); `lat` and `lng` go together (422); texts ≤ 300.

### Storefront — `GET /api/v1/store/:ws/branches?lat=&lng=`
- 404 when off. Else `{ branches: [{ id, name, address, phone, whatsapp, hours, note, lat, lng, pickup, directionsUrl, distanceKm }], nearest }` — with the shopper's coordinates (both or neither, else 422), nearest first with `distanceKm` (straight line) and `nearest` set. `pickup` = the branch takes click-and-collect orders (item 225). `directionsUrl` opens Google Maps directions.

### Screens
- Settings → Website → «فروعنا» / "Our branches": on/off; per location: show on site, phone, WhatsApp, opening hours (ar/en), note, and the map pin (lat/lng, or pick on a map).
- Storefront page `/branches` «فروعنا» / "Our stores": list/cards with address, hours, «اتصل» / "Call", «واتساب» / "WhatsApp", «الاتجاهات» / "Directions"; a button «أقرب فرع ليا» / "Nearest to me" asks the browser for location and sorts by distance («على بعد 3.2 كم» / "3.2 km away"); a badge «استلام من الفرع» / "Pickup available" when `pickup`.
- Footer link to the page when enabled.

## 234. Price history and the honest "lowest in 30 days" — UI: pending

### Dashboard — `GET /api/v1/workspaces/:ws/price-history/variants/:variantId?days=180` (`products.view`)
→ `{ current: { priceAmount, compareAtAmount, currency }, lowest30Days, changes: [{ priceAmount, compareAtAmount, changedAt }] }` (oldest first; every price / compare-at change, from any path: editor, bulk edit, scheduled sales).

### Storefront — `GET /api/v1/store/:ws/lowest-prices?variantIds=a,b` (≤ 50)
→ `{ days: 30, prices: { "<variantId>": "9000" } }` — the lowest price the variant really had in the last 30 days (including the price in force when the window opened, and today's). Bad ids → 422.

### Screens
- Product editor → variant → «تاريخ السعر» / "Price history": a step line chart (price and compare-at) and the list of changes with dates.
- Storefront product page / cards, only when a variant is on sale (compare-at above price): a small line «أقل سعر في آخر 30 يوم: 90 ج» / "Lowest price in the last 30 days: EGP 90". If that lowest is below today's price, show it as is — don't hide it.

## 235. Customer privacy requests (my data / delete my account) — UI: pending

### Storefront — `/api/v1/store/:ws/account/privacy` (X-Shopper-Token; 401 `SHOPPER_NOT_SIGNED_IN`)
- `GET /export` → the shopper's data as JSON (download, `Content-Disposition: attachment; filename="my-data.json"`): `{ exportedAt, profile, addresses, savedAddresses, orders: [{ orderNumber, createdAt, totalAmount, currency, paymentMethod, contact, shippingAddress, items }], loyalty: { balance, history }, storeCredit: { balance, history }, wishlist }`.
- `POST /erase` `{ reason? ≤ 500 }` → 201 `{ request: { id, kind: "erase", status: "pending", … } }` (200 with the same pending request if asked again).
- `GET /` → `{ requests: [{ id, kind, status, decisionNote, createdAt, completedAt }] }`.

### Dashboard — `/api/v1/workspaces/:ws/privacy-requests` (read `customers.view`, act `customers.manage`)
- `GET ?status=pending|completed|declined&kind=export|erase` → `{ requests: [{ id, customerId, kind, status, requesterLabel: "Mona A. · …2311", reason, decisionNote, completedAt, createdAt }], pending }`.
- `POST /:requestId/complete` `{ force?, note? }` → erases the customer. 409 `CUSTOMER_HAS_OPEN_ORDERS` «العميل عنده طلبات لسه في الطريق — امسح بعد ما تتسلّم أو اختار "امسح برضه"» / "This customer has orders still on their way — erase after delivery, or force it".
- `POST /:requestId/decline` `{ note }` (required).
- `GET /customers/:customerId/export` → the same JSON; `POST /customers/:customerId/erase` `{ force?, note? }` → `{ erased: true }` (asked by phone, etc.; logged as a completed request).
- What erase does: the customer becomes «Deleted customer» with no phone, email, company, tax ID or addresses; their orders keep amounts, lines and country/governorate/city but lose name, phone, email and street; saved cards, sign-in codes and wishlist are deleted; review author names hidden; the shopper is signed out. Can't be undone.

### Screens
- Storefront account → «الخصوصية» / "Privacy": «نزّل بياناتي» / "Download my data", «امسح حسابي» / "Delete my account" (reason, confirm «هنمسح بياناتك الشخصية؛ فواتيرك هتفضل محفوظة من غير اسمك» / "We'll remove your personal details; your invoices stay, without your name"), and the request status «تحت المراجعة» / "Under review", «اتمسح» / "Done", «اترفض» / "Declined" with the store's note.
- Dashboard → Customers → «طلبات الخصوصية» / "Privacy requests" (badge with `pending`): complete (confirm, warning that it can't be undone, force option when blocked), decline with a note. Customer page: «نزّل بيانات العميل» / "Export data" and «امسح العميل» / "Erase customer".

## 236. Post-purchase survey — UI: pending

### Checkout change
- Every checkout 201 now carries **`trackingToken`** (the order's signed tracking token, the same one as the `/track?t=` link). The thank-you page keeps it for the survey, the tracking page and self-service (item 220).

### Settings — `/api/v1/workspaces/:ws/post-purchase-survey` (read `orders.view`, save `workspace.manage`)
- `GET` / `PUT` `{ enabled, questions: [{ id?, type: "choice" | "score" | "text", text: { ar, en }, options: [{ id?, label: { ar, en } }] (choice: 2–12), allowOther (choice), required }] }` (≤ 3 questions; ids are generated and must be kept on later saves).
- `GET /orders/:orderId` → `{ answers, answeredAt }` for the order page.
- `GET /report?from=&to=` (default last 90 days) → `{ responses, questions: [choice: { options: [{ id, label, count }], other, otherTexts }, score: { average, nps, distribution[0..10], answers }, text: { latest: [{ text, orderNumber, at }] }] }`.

### Storefront — `/api/v1/store/:ws/survey`
- `GET /` → `{ questions: [{ id, type, text, options?, allowOther?, required }] }` or 404 when off.
- `GET /orders/:orderId?token=<trackingToken>` → `{ answered, answers, open }`.
- `PUT /orders/:orderId` `{ token, answers: { "<questionId>": "<optionId>" | { other: "…" } | 0–10 | "text" } }` → `{ answered: true, answers }`. Proof: `token` (tracking token), or `X-Shopper-Token`, or `X-Payment-Token` for an online order. Changeable for 7 days, then 409 `SURVEY_CLOSED`. 422 per question: «مطلوب» / "Required", «اختار من الاختيارات» / "Pick one of the options", «من 0 لـ 10» / "A score from 0 to 10".

### Screens
- Settings → Orders → «استبيان بعد الشراء» / "Post-purchase survey": on/off, up to 3 questions (type: «اختيار» / "Choice", «تقييم 0–10» / "Score 0–10", «نص» / "Text"), options, «ومكان لـ "حاجة تانية"» / "Allow other", required.
- Thank-you page: the questions under the order summary, «ابعت» / "Send", then «شكرًا على رأيك!» / "Thanks for your feedback!"; skippable.
- Order page: the answers. Analytics → «نتائج الاستبيان» / "Survey results": bar per option, average and NPS for the score, latest texts.

## Frontend requests (2026-10-07, third batch, docs/ux/backend-requests.md) — done

- **Waybill PDF and emoji (214):** the waybill's customer-details lines (gift message, custom-field answers, pickup and delivery-slot lines) drop emoji, flags, skin tones and joiners before drawing — the PDF fonts have no glyphs for them. «Happy birthday ❤️🎉 يا حبيبتي» prints as «Happy birthday يا حبيبتي». The order itself keeps the message as typed.
- **Cart: the product a free gift needs (208):** each `freeGifts[]` entry of the cart now has `neededProducts: [{ id, name, slug }]` (filled when `needsProduct` is true, active products only). Nudge: «ضيف Box cap وخد هدية» / "Add Box cap to get a free gift", linking to `/products/<slug>`.
- **Mix-and-match box prices (215):** new `POST /api/v1/store/:ws/bundles/:bundleId/quote` `{ picks: [{ variantId, quantity }] }` → `{ units, currency, full, discount, total, freeShipping, tiers: [{ tierId, title, sku, quantity, packs }], nextTier: { id, title, quantity, missingUnits } | null, ignored: [variantIds not in this box] }` — the same tier pricing the cart and checkout use. Show «الإجمالي 400 ج بدل 450» / "Total EGP 400 instead of 450" and «ضيف قطعة كمان وتوصل للعرض» / "Add 1 more to unlock the offer" from `nextTier.missingUnits`.

## 237. RFM customer scores — UI: pending

### `/api/v1/workspaces/:ws/rfm` (`customers.view`)
- `GET /` → `{ total, computedAt, labels: [{ label, customers, spent, avgOrders }] }` — every label in a fixed order, zeros included.
- `GET /customers?label=&sort=spent|recent|orders&limit≤200&offset=` → `{ total, customers: [{ customerId, fullName, lastOrderAt, daysSinceLastOrder, orders, spent, scores: { r, f, m }, label }] }`. Unknown label → 422.
- `GET /customers/:customerId` → `{ rfm }` (null when the customer has no delivered order).
- Scores 1–5 by quintile among this store's customers with at least one **delivered** order (refunds off, test and cancelled orders left out). Labels: `champions`, `cant_lose`, `at_risk`, `loyal`, `new`, `potential`, `lost`, `hibernating`, `need_attention`.

### Wording (ar / en)
«أبطال» Champions · «مينفعش نخسرهم» Can't lose them · «في خطر» At risk · «أوفياء» Loyal · «جداد» New · «واعدين» Promising · «ضاعوا» Lost · «نايمين» Hibernating · «محتاجين اهتمام» Need attention.

### Screens
- Customers → «تقسيم العملاء» / "Customer groups": a grid of the 9 labels (customers, money, avg orders), each opening the list; short help text per label («اشتروا كتير ومؤخرًا» / "Bought a lot, recently"…).
- Customer list: a filter «المجموعة» / "Group" using `/customers?label=`. Customer page: a badge with the label and the R/F/M scores.
- Note for the team: these groups are for looking and for targeting in their own work (e.g. a VIP tier or a personal call); nothing here sends messages.

## 238. Tax report — UI: pending

New report family: `/api/v1/workspaces/:ws/store-reports/*` — every report answers JSON, or CSV with `?format=csv` (UTF-8 with BOM, opens in Excel with Arabic); `from` / `to` ISO dates (default last 90 days); months/dates in the store's time zone.

### `GET /store-reports/tax?from=&to=&format=` (`financial_reports.view`)
```json
{ "from": "…", "to": "…", "timezone": "Africa/Cairo", "currency": "EGP",
  "totals": { "orders": 1, "taxable": "25000", "tax": "3500", "taxRefunded": "1750", "netTax": "1750", "exemptOrders": 1, "exemptSales": "25000" },
  "rows": [{ "month": "2026-10", "place": "القاهرة", "orders": 1, "taxable": "25000", "tax": "3500", "taxRefunded": "1750", "netTax": "1750", "exemptOrders": 0, "exemptSales": "0" }] }
```
- Counts orders that were delivered or paid (not cancelled, not test). `taxable` = subtotal − discount; a refund takes off its share of the tax; tax-exempt orders (item 228) are in `exemptOrders` / `exemptSales`. Amounts in minor units of the store currency.

### Screen
- Reports → «تقرير الضريبة» / "Tax report": date range, totals cards («الضريبة المحصّلة» / "Tax collected", «المرتجع» / "Refunded", «الصافي» / "Net", «مبيعات معفاة» / "Exempt sales"), table by month × governorate, «تنزيل CSV» / "Download CSV".

## 239. Inventory valuation — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/inventory-value?locationId=&format=json|csv` (`financial_reports.view`)
```json
{ "currency": "EGP",
  "totals": { "variants": 3, "units": 63, "value": "40000", "freeValue": "32000", "withoutCost": 2 },
  "locations": [{ "locationId": "…", "name": "Main", "units": 6, "value": "24000" }] | null,
  "variants": [{ "variantId": "…", "productName": "ZZ Val A", "sku": "ZZ-VA", "options": {}, "onHand": 10, "reserved": 2, "free": 8, "unitCost": "4000", "value": "40000", "locations": [{ "locationId": "…", "units": 6 }] }],
  "withoutCost": [{ "variantId": "…", "productName": "ZZ Val B", "sku": "ZZ-VB", "onHand": 3 }] }
```
- On-hand units × the variant's cost (minor units). `reserved` = promised to open orders (still on the shelf), `free` = on hand − reserved; `freeValue` values the free part. Variants without a cost are listed in `withoutCost` and left out of the totals. `locations` only when the store has stock locations; `locationId` narrows to one location. Stock-tracked, non-archived products with stock.

### Screen
- Reports → «قيمة المخزون» / "Inventory value": cards «قيمة المخزون بالتكلفة» / "Stock value at cost", «منها محجوز لطلبات» / "Of which reserved", «قطع» / "Units"; per-location table when there are locations; variants table; a warning box «N منتج من غير سعر تكلفة — مش داخلين في الحساب» / "N products have no cost — not counted" linking to the products; «تنزيل CSV».

## 240. Slow-moving and dead stock — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/slow-stock?days=30|60|90|180&includeNew=false&limit=&format=json|csv` (`analytics.view`)
```json
{ "days": 60, "currency": "EGP",
  "totals": { "variants": 2, "units": 19, "valueTiedUp": "75000", "neverSold": 1, "withoutCost": 0 },
  "variants": [{ "variantId": "…", "productName": "ZZ Old sale", "sku": "ZZ-OLD", "options": {}, "freeUnits": 9, "unitCost": "5000", "valueTiedUp": "45000", "lastSoldAt": "2026-07-24T…", "daysSinceSale": 75, "neverSold": false }] }
```
- Variants with free stock (on hand − reserved) and no sale (order line, not cancelled, not test) in the last `days`; most money tied up first. Variants created inside the window are left out (too new) unless `includeNew=true`. `days` other than 30/60/90/180 → 422.

### Screen
- Reports → «البضاعة الراكدة» / "Slow-moving stock": chips «30 يوم» «60 يوم» «90 يوم» «180 يوم», cards «فلوس محبوسة في المخزون» / "Money tied up", «عمرها ما اتباعت» / "Never sold"; table (product, free units, value, «آخر بيع» / "Last sold", «من كام يوم» / "Days ago"); row actions as links: «اعمل تخفيض مجدول» / "Schedule a sale" (item 227) and «اعرض المنتج» / "Open product"; «تنزيل CSV».

## 241. Discount code results — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/discounts?from=&to=&format=json|csv` (`analytics.view`)
```json
{ "from": "…", "to": "…", "currency": "EGP",
  "discounts": [{ "discountId": "…", "code": "ZZTEN", "automatic": false, "type": "percentage",
    "orders": 3, "cancelled": 1, "cancelRate": 33.3, "revenue": "45000", "deliveredRevenue": "22500",
    "discountGiven": "5000", "averageOrder": "22500", "newCustomers": 1, "returningCustomers": 1 }] }
```
- Orders placed in the window that used each discount (codes, and automatic discounts with `code: null`). `revenue`, `discountGiven`, `averageOrder`, new/returning count live orders (not cancelled/rejected); `deliveredRevenue` = delivered, refunds off. New = the customer's first order in the store. Highest revenue first.

### Screens
- Marketing → Discounts list: columns «طلبات» / "Orders", «مبيعات» / "Revenue", «خصم مدفوع» / "Discount given", «إلغاء» / "Cancelled %" from this report for the chosen range.
- Discount page: the same numbers, plus «عملاء جداد» / "New customers" vs «عملاء قدام» / "Returning", «اتسلّم فعلًا» / "Delivered revenue"; «تنزيل CSV».

## 242. Orders by weekday and hour (heatmap) — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/order-heatmap?from=&to=&format=json|csv` (`analytics.view`)
```json
{ "timezone": "Africa/Cairo", "currency": "EGP",
  "cells": [{ "weekday": 4, "hour": 21, "orders": 2, "revenue": "50000", "confirmationRate": 50 }],
  "byWeekday": [0,0,0,0,2,0,1], "byHour": [/* 24 */], "busiest": { "weekday": 4, "hour": 21, "orders": 2 } }
```
- Always 168 cells (7 × 24), `weekday` 0 = Sunday … 6 = Saturday, hours in the store's time zone. Live orders only (not cancelled/rejected, not test). `confirmationRate` = confirmed / COD orders in that cell (null without COD orders).

### Screen
- Reports → «أوقات الطلبات» / "When orders come in": a 7×24 heatmap (rows Sat…Fri for Egypt: «السبت» … «الجمعة»; columns 12am…11pm), toggle «عدد الطلبات» / "Orders" vs «المبيعات» / "Revenue", tooltip with the confirmation rate; a line «أكتر وقت: الخميس 9 م» / "Busiest: Thursday 9 PM"; bars by weekday and by hour under it; «تنزيل CSV».

## 243. Bulk stock and price update from a sheet — UI: pending

### `/api/v1/workspaces/:ws/catalog/bulk-update` (`products.manage`)
- `POST /preview` and `POST /apply` — the same input: a multipart `file` (CSV or xlsx, ≤ 10 MB), or JSON `{ csv: "…" }`. Header row; `sku` required (case-insensitive match); optional columns, blank = unchanged: `stock` (new count), `stock_change` (±units; not with `stock` on the same row), `price`, `compare_at` (`0` clears), `cost` — money in major units as typed ("129.50"). ≤ 5000 rows.
- Preview → `{ rows, summary: { rows, changes, unknown, errors }, changes: [{ row, sku, variantId, productName, options, fields: { stock: { from, to }, priceAmount: { from, to }, compareAtAmount, costAmount } }], unknown: [{ row, sku }], errors: [{ row, sku?, message }] }` — nothing changes.
- Apply → `{ applied, failed: [{ row, sku, message }], unknown, errors }`. Stock is set to the sheet's target against the stock at that moment (an inventory movement "Bulk update from a sheet"); prices go through the variant (price history, item 234). One audit entry.
- Row errors: «SKU مكرر في الشيت» / "This SKU is on an earlier row too", «فيه أكتر من صنف بنفس الـ SKU» / "Several variants share this SKU", «استخدم stock أو stock_change مش الاتنين» / "Use stock or stock_change, not both", «المخزون هيبقى أقل من صفر» / "Stock would go below 0", «السعر لازم رقم» / "Price must be a number". No `sku` column → 422.

### Screen
- Products → «تحديث جماعي من شيت» / "Bulk update from a sheet": a template download (sku, stock, stock_change, price, compare_at, cost), upload, the preview table (old → new per field, unknown SKUs and errors in their own tabs), «طبّق N تغيير» / "Apply N changes", then the result.

## 244. Packing slips — UI: pending

### `POST /api/v1/workspaces/:ws/orders/documents/packing-slips?size=A5|A4&as=pdf|base64` (`orders.view`)
- Body `{ orderIds: [uuid] (1–200), note?: "شكرًا لطلبك!" ≤ 300 }` → one page per order (in the order given): store name, «PACKING SLIP · order number · date», customer and address (or the pickup place), lines with options, SKU and quantity, the gift message, and the note at the bottom. Prices and total are shown, except on gift orders whose shopper asked to hide prices (item 214). Emoji are dropped. `as=base64` → `{ filename, contentType, base64, printed }`. No matching order → 422 `NO_ORDERS_SELECTED`.

### Screens
- Orders list → bulk actions: «ورقة التجهيز للطلب» / "Packing slips" next to waybills, invoices and pick list; a dialog with the size (A5/A4) and an optional note «رسالة في آخر الورقة» / "Note at the bottom" (remember the last note in the browser).
- Order page → «اطبع ورقة التجهيز» / "Print packing slip".

## 245. Sales by collection — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/sales-by-collection?from=&to=&format=json|csv` (`analytics.view`)
```json
{ "currency": "EGP",
  "collections": [{ "collectionId": "…", "name": "ZZ Shirts", "units": 3, "orders": 2, "products": 1, "revenue": "30000", "deliveredRevenue": "20000" }],
  "uncollected": { "units": 3, "revenue": "30000" } }
```
- Live orders placed in the window (not cancelled/rejected, not test); revenue = line totals after line discounts (store currency). A product in several collections counts in each — rows don't add up to the store total (say so under the table). `uncollected` = products in no collection.

### Screen
- Reports → «المبيعات حسب التشكيلة» / "Sales by collection": table + bar chart by revenue, «اتسلّم فعلًا» / "Delivered" column, a note «المنتج اللي في أكتر من تشكيلة بيتحسب في كل واحدة» / "A product in several collections counts in each", the «منتجات من غير تشكيلة» / "Not in any collection" row, «تنزيل CSV».

## 246. Sales by variant option (size, colour…) — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/sales-by-option?option=size&from=&to=&format=json|csv` (`analytics.view`)
```json
{ "currency": "EGP",
  "options": [{ "option": "Size", "units": 6, "values": [{ "option": "Size", "value": "M", "units": 5, "orders": 2, "products": 2, "revenue": "40000", "share": 83.3 }, { "value": "L", "units": 1, "share": 16.7 }] }] }
```
- From the option values each order line kept, live orders in the window. Names and values are matched trimmed and case-insensitively («M» = « m »); different words stay apart («Color» ≠ «Colour»). `option` narrows to one option name. `share` = % of that option's units.

### Screen
- Reports → «المبيعات حسب المقاس واللون» / "Sales by size and colour": one card per option (Size, Colour…) with a bar per value and its share («M — 83%»), a filter by option, and «تنزيل CSV». Help text: «استخدمها وانت بتطلب من المورّد: كام من كل مقاس» / "Use it when ordering from your supplier: how many of each size".

## 247. Returns by reason and return rate — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/returns?from=&to=&format=json|csv` (`analytics.view`)
```json
{ "currency": "EGP",
  "totals": { "requests": 3, "units": 7, "returnRate": 37.5, "refunds": 1, "refunded": "10000" },
  "reasons": [{ "reason": "damaged", "requests": 2, "rejected": 1, "completed": 1, "units": 5 }],
  "products": [{ "productId": "…", "name": "ZZ Ret Shoe", "delivered": 8, "returned": 3, "returnRate": 37.5, "reasons": ["damaged", "wrong_item"] }] }
```
- `reasons`: return requests opened in the window, by reason code (`damaged`, `defective`, `wrong_item`, `not_as_described`, `no_longer_wanted`, `arrived_late`, `other`). `completed` = received or refunded.
- `products`: for orders placed in the window, units delivered vs units in return requests that weren't rejected → `returnRate` %. `refunded` = refunds processed in the window. CSV = the products table.

### Screen
- Reports → «المرتجعات» / "Returns": cards «نسبة المرتجع» / "Return rate", «طلبات الإرجاع» / "Return requests", «فلوس اترجعت» / "Refunded"; a bar per reason with Arabic labels («تالف» damaged, «عيب صناعة» defective, «منتج غلط» wrong item, «مش زي الوصف» not as described, «مبقاش عايزه» no longer wanted, «اتأخر» arrived late, «سبب تاني» other); the products table sorted by returned units with the rate highlighted when high; «تنزيل CSV».

## 248. Merge duplicate customers — UI: pending

### `/api/v1/workspaces/:ws/customer-merge` (`customers.manage`)
- `GET /candidates/:customerId` → `{ candidates: [{ id, fullName, phone, email, totalOrders, createdAt, reasons: ["email" | "phone" | "name"] }] }` — possible duplicates: same email, same last 9 phone digits, or same name (up to 20).
- `POST /` `{ keepId, duplicateId }` → `{ customer: { id, fullName, phone, alternatePhone, email }, moved: { "orders.customer_id": 2, … }, pointsAdded, creditAdded }`.
  - Everything of the duplicate moves to the kept customer (orders, addresses, notes, follow-ups, reviews, wishlist, referrals, quotes, ledgers, …); the duplicate's copy is dropped where the kept one already has the same review / wishlist item / course / referral code. Points and store credit are added with a `merge` ledger line. Gaps on the kept customer are filled (name, email, company, tax ID); the duplicate's phone becomes the alternate phone if empty; tags and saved addresses joined; consent and blacklist kept if either had them. The duplicate is deleted (can't be undone); the kept customer's sign-ins restart.
  - Errors: 422 same customer; 404; 409 `CUSTOMER_PAYMENT_IN_PROGRESS` «في دفع أونلاين شغال لأحدهم — جرّب بعد ما يخلص» / "One of them has an online payment in progress — try again when it's done".

### Screens
- Customer page → «عملاء ممكن يكونوا نفس الشخص» / "Possible duplicates" (from `/candidates`, with the reason chips «نفس الإيميل» / «نفس الرقم» / «نفس الاسم»), and «دمج» / "Merge": a side-by-side of both customers, a choice of which to keep, a confirmation «هننقل كل طلبات وبيانات العميل التاني للعميل ده ونمسحه — مينفعش يترجع» / "All of the other customer's orders and data move here and it is deleted — this can't be undone", then the result (what moved).

## 249. Scan to pack — UI: pending

### `/api/v1/workspaces/:ws/orders/:orderId/pack` (`orders.manage`)
Nothing is stored between calls: the page keeps the list of scans and sends all of them each time (a reload or a second device just sends the list again).
- `POST /check` `{ "scans": ["6221234567890", "ZZ-PACK-1"] }` →
```json
{ "order": { "id": "…", "orderNumber": "ORD-…", "packed": false },
  "lines": [{ "variantId": "…", "name": "ZZ Pack Test", "options": {}, "sku": "ZZ-PACK-1", "barcode": "6221234567890",
              "expected": 2, "scanned": 1, "done": false, "missing": 1, "over": 0 }],
  "manual": [], "unknown": ["NOPE"], "over": [{ "variantId": "…", "name": "…", "over": 1 }],
  "complete": false, "progress": { "scanned": 1, "expected": 2 } }
```
  - A scan matches a variant's barcode or SKU (trimmed, upper/lower case ignored). `unknown` = codes that aren't in this order (wrong item). `over` = scanned more than ordered. `manual` = lines with no variant (can't be scanned; tick by hand). `complete` = every line scanned exactly and no unknown codes.
  - Up to 2000 scans, each ≤ 120 chars. 404 order; 409 `ORDER_CANCELLED`.
- `POST /confirm` `{ "scans": [...], "force": false, "note": "" }` → `{ "packed": true, "complete": true }`. Adds the tag `packed` to the order and an audit/timeline entry (`order.packed`, with the progress and any unknown codes).
  - Not complete → 409 `PACK_NOT_COMPLETE` (`details.lines`, `details.unknown`), unless `force: true` with a `note` (422 on `note` without one) — e.g. an item without a barcode.

### Screen
- Order page and the pick list → «تغليف بالسكانر» / "Scan to pack": a big input that keeps focus (a USB/Bluetooth scanner types and presses Enter; the phone camera can also fill it), the lines with «اتسكن ١ من ٢» / "1 of 2 scanned" and a tick when done, a progress bar, a beep/red flash for «المنتج ده مش في الطلب» / "This item isn't in the order" and «زيادة عن المطلوب» / "More than ordered", an «تراجع» / "Undo last scan" button.
- When complete: «كله تمام — تأكيد التغليف» / "All scanned — confirm packed". Otherwise «تأكيد رغم النقص» / "Confirm anyway" opens a required note «ليه؟» / "Why?". After confirm show the `packed` chip «اتغلّف» / "Packed" on the order and in the orders list (filter by tag `packed`).

## 250. Customer timeline — UI: pending

### `GET /api/v1/workspaces/:ws/customers/:customerId/timeline?limit=30&cursor=&kinds=` (`customers.view`)
```json
{ "events": [
    { "kind": "question", "at": "2026-10-07T01:04:41.661Z", "id": "…", "orderId": null, "orderNumber": null,
      "data": { "question": "Is it cotton?", "answer": null, "status": "pending", "productId": "…", "product": "ZZ TL Test" } },
    { "kind": "order_cancelled", "at": "…", "id": "…", "orderId": "…", "orderNumber": "ORD-…", "data": { "reason": "customer_request" } },
    { "kind": "order_placed", "at": "…", "id": "…", "orderId": "…", "orderNumber": "ORD-…",
      "data": { "total": "1000", "currency": "EGP", "paymentMethod": "cod", "source": "…", "isTest": false } } ],
  "next": "MjAyNi0xMC0w…" }
```
- Newest first. `limit` 1–100 (default 30). Pass `next` back as `cursor` for the next page; `next: null` = the end. A cursor stays valid when new events arrive, so «تحميل المزيد» never repeats or skips.
- `kinds` (comma list or repeated) narrows the feed; unknown kind or bad cursor → 422; 404 customer.
- Kinds and their `data` (amounts in minor units, as strings):

| kind | data | ar / en label |
|---|---|---|
| `order_placed` | total, currency, paymentMethod, source, isTest | «طلب جديد» / "Order placed" |
| `order_shipped` | carrier, waybill, trackingUrl | «اتشحن» / "Shipped" |
| `order_delivered` | carrier, waybill | «اتسلّم» / "Delivered" |
| `order_cancelled` | reason | «اتلغى» / "Cancelled" |
| `return_requested` | reason, status, items | «طلب إرجاع» / "Return requested" |
| `refund` | amount, currency, status, reason | «فلوس اترجعت» / "Refund" |
| `note` | body, pinned, author | «ملاحظة» / "Note" |
| `followup` | title, dueAt, doneAt, assignee | «متابعة» / "Follow-up" |
| `review` | rating, comment, status, productId, product | «تقييم» / "Review" |
| `question` | question, answer, status, productId, product (asked from the customer's email) | «سؤال عن منتج» / "Product question" |
| `loyalty` | kind, points, balanceAfter, note | «نقاط» / "Points" |
| `store_credit` | kind, amount, balanceAfter, currency, note | «رصيد» / "Store credit" |
| `quote` | number, status, currency, validUntil | «عرض سعر» / "Quote" |
| `privacy_request` | kind, status, completedAt | «طلب خصوصية» / "Privacy request" |
| `referral` | status, friend, rewardedAt | «رشّح صاحبه» / "Referred a friend" |
| `form` | form, page, message | «بعت فورم» / "Sent a form" |

### Screen
- Customer page → tab «كل اللي حصل» / "Timeline": a vertical feed with an icon per kind, the time («من ساعتين» / "2 hours ago", full date on hover), a one-line summary from `data` and a link to the order (`orderNumber`) or product; filter chips «طلبات» / "Orders" (order_* + return_requested + refund), «ملاحظات ومتابعات» / "Notes & follow-ups", «تقييمات وأسئلة» / "Reviews & questions", «نقاط ورصيد» / "Points & credit", «تاني» / "Other"; «تحميل المزيد» / "Load more" while `next` is set. Empty: «لسه مفيش حاجة مع العميل ده» / "Nothing with this customer yet".

## 251. More ad platforms for tracking pixels — UI: pending

### Same endpoints: `/api/v1/workspaces/:ws/tracking-pixels` (`marketing` permissions as before)
New `platform` values (browser tag only — `capiSupported: false`, no token field, «اختبار» test-send answers 422 `TRACKING_PIXEL_NO_SERVER_API`):

| platform | label | ID field (validation) | example |
|---|---|---|---|
| `x` | X (Twitter) | Pixel ID, 4–12 letters/digits | `o1abc` |
| `taboola` | Taboola | Account ID, 4–10 digits | `1234567` |
| `outbrain` | Outbrain | Marketer ID, 20–40 hex | `00a1b2c3…` |
| `kwai` | Kwai | Pixel ID, 10–25 digits | `248123456789012345` |
| `reddit` | Reddit | Pixel ID `t2_…` or `a2_…` | `a2_abc123def` |
| `microsoft` | Microsoft Ads (Bing UET) | UET tag ID, 5–12 digits | `187654321` |

- X only: `config.eventIds = { page_view?, view_content?, add_to_cart?, begin_checkout?, add_payment_info?, purchase?, lead? }`, each an X Ads Manager event id `tw-<pixel>-<event>` (422 otherwise). An event without an id isn't sent to X.
- Scope (all / funnels / products), label and on/off work as for the other platforms.

### Storefront: `GET /store/:ws` → `trackingPixels[]`
These pixels carry `events`: our event → the platform's name, `null` = don't send:
```json
{ "platform": "taboola", "pixelId": "1234567", "scope": { "type": "all", "ids": [] },
  "events": { "page_view": "page_view", "view_content": "view_content", "add_to_cart": "add_to_cart", "begin_checkout": "start_checkout",
              "add_payment_info": "add_payment_info", "purchase": "make_purchase", "lead": "lead" } }
```
- Load each tag the platform's standard way: X `twq('config', id)` + `twq('event', eventId, { value, currency, conversion_id: orderId })`; Taboola `_tfa.push({ notify: 'event', name, id: pixelId, revenue, currency })`; Outbrain `obApi('track', name, { orderValue, currency, orderId })`; Kwai `kwaiq.load(id); kwaiq.page()` + `kwaiq.instance(id).track(name, { value, currency })`; Reddit `rdt('init', id); rdt('track', name, { value, currency, transactionId })`; Microsoft `uetq.push('event', name, { revenue_value, currency })` (page load is automatic).
- Same consent rule as the other pixels (cookie consent, «Send Lead instead of Purchase» → fire `lead` instead of `purchase`), same event id per order.

### Screen
- Marketing → Tracking pixels → «إضافة بكسل» / "Add pixel": six new tiles with logos; the ID field with the hint per platform («رقم الحساب من Taboola Ads» / "Account ID from Taboola Ads"…); for X a small table «أكواد الأحداث» / "Event IDs" (Purchase, Lead, Add to cart, Checkout…). No «Conversions API» switch for these: a note «البكسل ده بيشتغل من المتصفح بس» / "This pixel works in the browser only".

## 252. Transfer a store to another owner — UI: pending

### `/api/v1/workspaces/:ws/ownership-transfer` (the store's owner only — anyone else gets 403 `NOT_STORE_OWNER`)
- `GET /candidates` → `{ candidates: [{ userId, fullName, email, role: { key, name } }] }` — active team members with an active account (invite someone first if the person isn't on the team).
- `POST /` `{ "newOwnerUserId": "…", "password": "…", "keepAs": "workspace_manager" | "owner" | "leave" }` (default `workspace_manager`) →
```json
{ "workspace": { "id": "…", "name": "Demo Store", "ownerUserId": "…" },
  "newOwner": { "userId": "…", "fullName": "ZZ Heir", "email": "…" },
  "previousOwner": { "userId": "…", "keptAs": "workspace_manager" },
  "billing": { "plan": "Starter", "external": false } }
```
  - The new person becomes the store's owner (role Owner); the old owner becomes Store manager, stays an Owner, or leaves the team. The plan and subscription stay with the store. Both get an email.
  - Errors: 422 `password` wrong / account has no password («اعمل باسورد لحسابك الأول» / "Set a password on your account first"); 422 picking yourself; 404 not an active team member; 409 `PLAN_LIMIT_REACHED` (`details.max`, `details.used`) when the new owner's plan has no room for another store.
  - After `leave`, the caller has no access: send them to the store list. After `workspace_manager`, refresh the session's permissions.

### Screen
- Settings → Team (owner only) → «نقل ملكية المتجر» / "Transfer ownership" (danger zone): pick a team member, choose «أفضل في المتجر كمدير» / "Stay as store manager" · «أفضل مالك معاه» / "Stay as an owner too" · «أخرج من المتجر» / "Leave the store", type the password, and confirm with «المتجر هيبقى ملك {name} — الخطة والفريق والإعدادات معاه. مينفعش ترجّعه غير لو هو رجّعهولك» / "The store will belong to {name} — plan, team and settings. Only they can hand it back". Success toast «المتجر بقى ملك {name}» / "{name} now owns the store".

## 253. Cart offers — UI: pending

### Staff: `/api/v1/workspaces/:ws/cart-offers`
- `GET /` (`products.view`) → `{ rules: [...] }`; `PUT /` (`discounts.manage`) `{ rules: [...] }` replaces the list (20 at most) → `{ rules }`.
```json
{ "rules": [{ "name": "Matching socks 20% off", "variantId": "…", "discountPercent": 20, "maxQuantity": 1,
              "productIds": ["…"], "minSubtotal": null, "startsAt": null, "endsAt": null, "active": true }] }
```
- `discountPercent` (1–100) **or** `offerPriceAmount` (minor units), exactly one; `maxQuantity` 1–10 (default 1); at least one of `productIds` (the cart has one of them) / `minSubtotal` (minor units; the rest of the cart reaches it) — both set = both needed. 422 when a variant/product isn't in the store, when the only trigger is the offered product itself, or when it ends before it starts.

### Storefront: the cart (`GET/POST/PATCH /store/:ws/cart…`) gains `cartOffers`
```json
"cartOffers": {
  "offers": [{ "ruleId": "…", "name": "Matching socks 20% off",
               "variant": { "variantId": "…", "productId": "…", "productName": "ZZ CO Offer", "slug": "zz-co-offer", "optionValues": {}, "imageUrl": null },
               "regularPrice": "5000", "offerPrice": "4000", "discountPercent": 20, "maxQuantity": 1,
               "inCart": false, "applied": false, "overMaxQuantity": false }],
  "locked": [{ "ruleId": "…", "name": "Big cart deal", "variant": { "variantId": "…", "productName": "…", "slug": "…" },
               "regularPrice": "10000", "offerPrice": "1000", "missingAmount": "50000", "needsProduct": false }] }
```
- `offers`: rules that hold now. Add it with the normal `POST /cart/items { variantId, quantity: 1 }` — the line is then priced at `offerPrice` (`applied: true`) and the cart totals include it. Above `maxQuantity` the line is back at the normal price (`overMaxQuantity: true`).
- `locked`: rules not reached yet («ضيف بـ {missingAmount} كمان وخد … بـ {offerPrice}» / "Add {missingAmount} more to get … for {offerPrice}"); `needsProduct` = it needs a certain product.
- The checkout charges the same price (lines within `maxQuantity`, never higher than the price already shown). Not in funnel checkouts. Buying the offered product alone gets no offer price.

### Screens
- Marketing → «عروض السلة» / "Cart offers": the list of rules (name, product, «خصم ٢٠٪» or «بـ ٤٠ ج.م», condition, dates, on/off), and an editor: product + variant picker, «نوع الخصم» / "Discount" (percent / fixed price), «أقصى كمية بالسعر ده» / "Max quantity at this price", «يظهر لما» / "Show when": «السلة فيها منتج من دول» / "the cart has one of these products" and/or «السلة توصل لـ» / "the cart reaches", start/end.
- Storefront cart drawer / cart page: a card per offer — image, name, «بدل {regularPrice}» struck through, «{offerPrice}», «ضيف للسلة» / "Add to cart" (or «في السلة ✓» / "In your cart" when `inCart`); a note when `overMaxQuantity`: «السعر المخفض لأول {maxQuantity} بس» / "The offer price is for up to {maxQuantity}"; locked offers as a progress hint.

## 254. Attribution and ad spend for the new ad platforms — UI: pending

No new endpoints; new values in existing ones.
- Ad spend (`/workspaces/:ws/profit/ad-spend`, `…/import`): `platform` also takes `pinterest`, `x`, `taboola`, `outbrain`, `kwai`, `reddit`, `microsoft` (before `other`). The CSV import maps «Bing» / «Microsoft Ads» → `microsoft`, «Twitter» → `x`. Labels: Pinterest, X (Twitter), Taboola, Outbrain, Kwai, Reddit, Microsoft Ads (Bing).
- Attribution / campaigns reports: orders from these platforms now come back under those platform keys — give each a logo/colour in the source lists and charts.
- Storefront (`lib/touches.ts` and the events batch): also keep the click ids `twclid`, `rdt_cid`, `msclkid`, `tblci` from the landing URL — in `touches.first/last`, in `attribution.clickIds`, and in the checkout-session `touch`, like `fbclid`/`ttclid`/`gclid`. The server reads them from the event URL too.
- Ad link builder (if shown): suggest `utm_source=taboola|outbrain|kwai|reddit|x|bing` for those platforms; Outbrain and Kwai links need `utm_source` (they add no click id).

## 255. Server-side conversions for Reddit, X and Microsoft Ads — UI: pending

Same endpoints as before (`/workspaces/:ws/tracking-pixels`). `reddit`, `x` and `microsoft` now have `capiSupported: true`, so the pixel form shows the «Conversions API» switch and the token field for them (the token is sealed; only `capiTokenMask` comes back).
- **Reddit**: token = Conversions access token (Reddit Ads → Events Manager). `testEventCode` (any text) = test mode («وضع الاختبار» / "Test mode").
- **Microsoft Ads**: token = the UET tag's CAPI token (Microsoft Advertising → UET tag → Conversions API).
- **X**: token = four keys joined by colons: `consumerKey:consumerSecret:accessToken:accessTokenSecret` (422 on `capiToken` otherwise: «لـ X اكتب المفاتيح الأربعة مفصولة بـ :» / "For X, paste the four keys separated by colons"). Show four inputs and join them. Conversions go only for events that have an X event id (`config.eventIds`, item 251).
- `POST /tracking-pixels/:id/test` → `{ ok, skipped, error, eventId, usedTestCode }`. `skipped: true` (X): «X مفيهوش حدث تجريبي — هيتأكد من المفاتيح مع أول طلب» / "X has no test event — the keys are checked with the first order".
- Orders go to them like the other platforms (Purchase, or Lead for stores/funnels that report leads), with the same event id as the browser tag, the click ids from item 254, hashed email/phone. Until the owner turns each on live (`*_CAPI_MODE=live`), the server builds the events and logs them without sending (sandbox) — say «تجريبي» / "Sandbox" next to these switches until then if the API reports it (not exposed yet).

## 256. Cart offers and free gifts report — UI: pending

### `GET /api/v1/workspaces/:ws/store-reports/cart-offers?from=&to=&format=json|csv` (`analytics.view`)
```json
{ "currency": "EGP", "store": { "orders": 120, "averageOrder": "14000" },
  "rules": [{ "name": "Matching socks 20% off", "kind": "cart_offer", "orders": 14, "units": 15,
              "lineRevenue": "56000", "ordersRevenue": "196000", "averageOrder": "14000" },
            { "name": "Free tote over 100", "kind": "free_gift", "orders": 30, "units": 30, "lineRevenue": "0", "ordersRevenue": "510000", "averageOrder": "17000" }] }
```
- `lineRevenue` = what the offered lines sold for; `ordersRevenue` / `averageOrder` = the whole orders that had them, to set against `store.averageOrder`. Minor units. Not cancelled, not test. Counts orders from now on (older orders weren't labelled).
- Order lines: an offer-priced or gift line now has `offerNameSnapshot` = the rule's name — show it under the product name on the order page («من عرض: …» / "From offer: …").

### Screen
- Reports → «عروض السلة والهدايا» / "Cart offers & gifts": a row per rule with a kind chip («عرض سلة» / "Cart offer", «هدية» / "Free gift"), orders, units, «مبيعات العرض» / "Offer sales", «متوسط الطلب» / "Average order" next to the store's average (green when higher), CSV download. Link from the Cart offers and Free gifts screens («شوف النتايج» / "See results").

## 257. Live or sandbox server events — UI: pending

`GET /api/v1/workspaces/:ws/tracking-pixels` → `platforms[].serverMode` and every `pixels[].serverMode`: `"live"` | `"sandbox"` | `null` (no server API, or a Google `AW-` id).
- Next to the «Conversions API» switch: `sandbox` → a grey chip «تجريبي — مش بيتبعت لسه» / "Sandbox — not sent yet" with help «الأحداث بتتجهّز وتتسجّل بس، لحد ما نفعّل المنصة دي» / "Events are built and logged only, until this platform is switched on"; `live` → nothing (or «شغال» / "Live").

## 258. Spin to win — UI: pending

### Staff: `/api/v1/workspaces/:ws/spin-wheel` (`discounts.manage`)
- `GET /` → `{ config, preview, stats: { spins, prizes } }` (`preview` = what the shop would show, with chances).
- `PUT /` the whole config:
```json
{ "enabled": true, "title": "جرّب حظك", "text": "لف العجلة وخد خصم على أول طلب", "delaySeconds": 10,
  "slices": [{ "label": "10%", "discountId": "…", "weight": 30 }, { "label": "20%", "discountId": "…", "weight": 10 },
             { "label": "حظ أوفر", "discountId": null, "weight": 60 }] }
```
  2–12 slices; `label` ≤ 40; `weight` 0–1000 (relative); a prize is a store discount **with a code** (422 otherwise); at least one prize with weight > 0.

### Storefront: `/api/v1/store/:ws/spin-wheel`
- `GET /` → `{ wheel: null | { title, text, delaySeconds, slices: [{ id, label, prize, chance }] } }` — `chance` in % (one decimal). Show the chances on the wheel or under it («فرص الفوز: ١٠٪ — ٣٠٪ …» / "Chances: …"); ended coupons are already left out.
- `POST /spin` `{ phone, fullName?, marketingConsent: true, website: "" }` → 201 `{ sliceId, label, prize, couponCode }`. Animate the wheel to `sliceId` **after** the answer. 409 `ALREADY_SPUN` «الرقم ده لف العجلة قبل كده» / "This number has already spun"; 422 without the consent tick; 404 `SPIN_WHEEL_OFF`.

### Screens
- Marketing → «عجلة الحظ» / "Spin to win": on/off, title, text, delay, slices (label, prize = pick a discount or «من غير جايزة» / "No prize", weight with the live % next to it), the preview wheel, stats «لفّات / جوايز» / "Spins / prizes".
- Storefront popup after `delaySeconds`: the wheel with labels and chances, phone + name, a required tick «موافق أستقبل عروض من المتجر» / "I agree to receive offers from the store", «لف العجلة» / "Spin"; the result «مبروك! كود الخصم: ZZSPIN10» with copy, or «حظ أوفر المرة الجاية» / "Better luck next time". Don't show it again once spun (remember locally).

## 259. «Offer» column in the order export — UI: pending

`GET /workspaces/:ws/orders/export/columns` now lists `offerName` («العرض» / "Offer"), an item column (with `rowPer=item`): the offer, bundle, cart offer or free gift the line came from, empty otherwise. Add it to the column picker beside Product / Variant / SKU.

## 260. Excel for lost orders and courier tracking — UI: pending

- `POST /api/v1/workspaces/:ws/checkout-sessions/export` (`orders.view`) takes `format: "csv" | "xlsx"` beside the filters. `xlsx` → `{ base64, contentType, count, filename: "lost-orders-YYYY-MM-DD.xlsx" }` (same columns as the CSV; phones masked the same way). Lost orders → Export: «Excel» / «CSV» choice; decode `base64` and download.
- `POST /api/v1/workspaces/:ws/orders/import-tracking` takes `{ csv }` **or** `{ xlsx: "<base64 of the .xlsx>" }` (exactly one; ≤ ~1.5 MB). Same columns (`order_number`, `tracking_number`, `tracking_url`, `carrier`, `status`; header names any case/spaces) and the same per-row result. 422 `BAD_FILE` «الملف ده مش إكسيل (.xlsx)» / "This is not an Excel (.xlsx) file". Orders → Import tracking: accept `.csv` and `.xlsx`.

## 261. Ad accounts and campaign controls — UI: pending

All under `/api/v1/workspaces/:ws/profit/ads` — reads `financial_reports.view`, changes `profit.manage`.
- `GET /adapters` → `{ adapters: [{ code, name, platforms, supportsOAuth }] }` (only `sandbox` today; real Meta/TikTok/Snapchat/Google adapters plug in later).
- `POST /connections` `{ adapter: "sandbox", credentials: { … } }` → 201 `{ connection }`; 422 `ADS_CREDENTIALS_REJECTED`. Credentials are sealed and never returned.
- `GET /connections` → `{ connections: [{ adapter, status, accounts: [{ accountId, name, platform, currency, selected }], campaigns: { "<accountId>:<campaignId>": { status, dailyBudgetAmount, updatedAt } }, lastVerifiedAt, lastError }] }`
- `PUT /connections/:adapter/accounts` `{ accountIds: [...] }` → the merchant's pick (only picked accounts are synced and can be controlled); 422 for an id not in `accounts`.
- `DELETE /connections/:adapter` → `{ disconnected: true }` (spend already recorded stays).
- `POST /campaigns/:campaignId/status` `{ adapter, accountId, status: "paused" | "active" }` and `PUT /campaigns/:campaignId/budget` `{ adapter, accountId, dailyBudgetAmount }` (minor units) → `{ campaign: { campaignId, accountId, status?, dailyBudgetAmount?, updatedAt } }`. 422 if the account isn't picked, 422 `ADS_CHANGE_REFUSED`, 502 `ADS_PLATFORM_UNREACHABLE`.
- `POST /profit/ads/sync` (existing) now has accounts to pull.

### Screens
- Profit → «حسابات الإعلانات» / "Ad accounts": connect (pick the platform/adapter, its key fields), then a checklist of the accounts found «اختار الحسابات اللي تتابعها» / "Pick the accounts to follow", «فصل» / "Disconnect", last sync / error.
- Campaigns screen: per campaign row (with its `campaignId` and account) a «إيقاف / تشغيل» / "Pause / Resume" toggle and «الميزانية اليومية» / "Daily budget" edit with confirm «هيتغيّر على المنصة نفسها» / "This changes it on the ad platform". Show the last state from `connections[].campaigns`.

## 262. Merchant sign-in with a WhatsApp code — UI: pending

Public, rate-limited like the other sign-in routes.
- `POST /api/v1/auth/login/whatsapp/request` `{ phone, locale: "ar" | "en" | "fr" }` → `{ challengeToken, channel: "whatsapp" | "sms", sentTo: "2010*****621" }`. The same answer for a phone with no account (no code is sent then) — don't say "no account". 429 `TOO_MANY_CODES`; 503 `CODE_NOT_DELIVERED` «مقدرناش نبعت الكود — ادخل بالإيميل والباسورد» / "We couldn't send the code — sign in with email and password".
- `POST /api/v1/auth/login/whatsapp/verify` `{ challengeToken, code: "123456", locale }` → the same answer as `POST /auth/login`: `{ user, accessToken, refreshToken, … }` (refresh cookie as usual), or, for an account with an authenticator app / email codes, `{ twoFactorRequired, challengeToken, channel }` → finish with the existing `POST /auth/two-factor/verify`. 401 `INVALID_LOGIN_CODE` «الكود غلط أو انتهى» / "Wrong or expired code"; 429 `TOO_MANY_ATTEMPTS` after 5 wrong codes.
- Works only for a phone verified on the account (Settings → Security → verify phone).

### Screen
- Sign-in page: a third option «ادخل بكود واتساب» / "Sign in with a WhatsApp code" → phone field → «ابعت الكود» / "Send code" → «بعتنا كود لـ {sentTo}» / "We sent a code to {sentTo}" + 6-digit input, «ابعت تاني» / "Resend" after 60 s; then the usual second-step screen when asked. Hint under the phone: «لازم يكون الرقم متأكد في حسابك» / "The number must be verified on your account".

## 263. Dropship suppliers: their shipping rates and minimum order — UI: pending

- `PATCH /api/v1/workspaces/:ws/dropship/providers/:code/settings` (`apps.manage`) also takes `useSupplierShipping` and `enforceMinimum` (booleans); the supplier list (`GET /providers`) returns both with the other settings. 422 `DROPSHIP_NOT_SUPPORTED` when the supplier can't give shipping prices / has no minimum.
- `useSupplierShipping`: an order whose every product is that supplier's is charged the supplier's shipping price (store free-shipping rules still win; mixed orders keep the store's rates). The shipping quote's `rule` is then `supplier_rate`.
- `enforceMinimum`: the shopper's checkout is refused below the supplier's minimum → 422 `BELOW_SUPPLIER_MINIMUM` with `details { supplierName, minimumAmount, linesAmount, missingAmount }` «الطلب أقل من الحد الأدنى للمورّد — ضيف بـ {missingAmount} كمان» / "The order is below the supplier's minimum — add {missingAmount} more".
- The storefront shipping quote (`POST /store/:ws/shipping-quote`) now has `supplierMinimum` (same object, or null) — show it in the cart/checkout before submit and disable «اطلب» / "Order" until it's reached.

### Screen
- Apps → the supplier's card → settings: two switches «استخدم أسعار شحن المورّد» / "Use the supplier's shipping rates" and «ارفض الطلب لو أقل من الحد الأدنى للمورّد» / "Refuse orders below the supplier's minimum" (disabled with a hint when the supplier doesn't support it).

## 264. Product feeds per channel — UI: pending

Same endpoints: `GET / PUT /api/v1/workspaces/:ws/offers/feed`. The PUT body (whole, as before) gains `channels`:
```json
{ "enabled": true, "collectionIds": [], "excludeOutOfStock": true, "brand": "", "googleProductCategory": "",
  "channels": {
    "google":   { "enabled": true, "collectionIds": ["…"], "excludeOutOfStock": null, "requireChecklist": true },
    "meta":     { "enabled": true, "collectionIds": null, "excludeOutOfStock": false },
    "tiktok":   { "enabled": false },
    "snapchat": {} } }
```
- Per channel: `enabled` (default true), `collectionIds` / `excludeOutOfStock` — `null` = follow the store-wide choice; `requireChecklist` (Google only) = no Google feed until the Merchant checklist passes. A channel left out of `channels` goes back to defaults.
- The GET (and PUT answer) gains `channels: { meta|google|tiktok|snapchat: { live, heldBackByChecklist, itemCount, productCount } }`; `links` as before. A channel that isn't live answers 404 at its link.

### Screen
- Marketing → «فيد المنتجات» / "Product feeds": keep the store-wide settings on top; below, one card per channel (logo, «شغال / مقفول» / "Live / Off" switch, its link with copy, items count), «استخدم إعدادات المتجر» / "Use the store settings" ticked by default, else its own collections picker and «استبعد المنتجات الخلصانة» / "Leave out sold-out items". Google card: «متنشرش غير لما قايمة جوجل تكمل» / "Don't publish until the Google checklist is complete", and when `heldBackByChecklist` a link to the checklist.

## 265. Partner apps with OAuth — UI: pending

Developer guide: `src/modules/partnerApps/README.md` (link it from the developer screen).

### Developers (`/api/v1/partner-apps`, any signed-in account)
- `GET /` → `{ apps: [{ id, name, description, iconUrl, appUrl, redirectUris, scopes, clientId, status }], scopes: [all scope names] }`
- `POST /` `{ name, description, iconUrl (https), appUrl (https), redirectUris: [1–10, https or http://localhost, no #], scopes: [≥1] }` → 201 `{ app: { …, clientSecret } }` (secret shown once). 409 `PARTNER_APP_LIMIT` (20).
- `PATCH /:id` (any of those fields), `POST /:id/rotate-secret` → `{ app: { …, clientSecret } }`, `GET /:id/installs` → `{ installs: [{ storeId, storeName, scopes, installedAt }] }`, `DELETE /:id` (uninstalls it everywhere).

### Merchant approval (dashboard route `/oauth/authorize?client_id&redirect_uri&scope&state`) — `apps.manage`
- `GET /api/v1/workspaces/:ws/oauth/authorize?client_id=…&redirect_uri=…&scope=…&state=…` → `{ app: { name, description, iconUrl, developer, status, redirectHost }, scopes, installed }`. 404 unknown/suspended app; 422 unregistered redirect or scope; 403 `APP_IN_DEVELOPMENT`.
- `POST …/oauth/authorize` same fields + `approve: true|false` → `{ redirectTo }` → `window.location = redirectTo`.
- The app then shows on the Apps page like other outside apps (uninstall = the existing external uninstall).

### The app's page — any store member
- `GET /api/v1/workspaces/:ws/apps/partner/:installId/embed` → `{ url, name }` (signed, valid 5 minutes) — render in an `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups">`; ask for a fresh url each time it opens. 404 when the app has no page. Installs with a page have `external.embedded`.

### Platform admin
- `GET /api/v1/admin/partner-apps?status=` (`providers.view`), `PATCH /api/v1/admin/partner-apps/:id { status: development | published | suspended }` (`providers.manage`; suspending removes its installs).

### Screens
- Account → «المطوّرين» / "Developers": my apps, create (name, icon, page URL, callback URLs, permissions), «انسخ Client ID / Secret» with «مش هيظهر تاني» / "Shown once", rotate, installs.
- `/oauth/authorize`: store picker (stores where I have apps.manage), the app card, «التطبيق ده عايز:» / "This app wants to:" with each scope in words, «سماح» / «رفض» (Allow / Deny), a note for development apps «تطبيق تحت التطوير» / "App in development".
- Apps → an installed partner app with a page: «افتح» / "Open" → full-width frame.
- Platform admin → «تطبيقات الشركاء» / "Partner apps": list by status, publish / suspend.

## 266. App webhooks stop with the app — UI: pending

- Webhook endpoints (`GET /workspaces/:ws/webhooks`) gain `createdByApp: true` for ones an app created through the public API. When that app is uninstalled (or its key revoked) they turn off with `disabledReason: "api_key_revoked"`; switching one back on answers 409 `WEBHOOK_APP_REMOVED`.
- Screen: Webhooks list — a chip «من تطبيق» / "From an app" on those; for `api_key_revoked` show «اتقفل لأن التطبيق اتشال» / "Off because the app was removed" and hide the «تشغيل» / "Turn on" switch.

## 267. Uninstall notice to partner apps — UI: pending

- Partner apps gain `uninstallUrl` (https; private addresses refused in production, like webhooks) in `POST / PATCH /api/v1/partner-apps` and in every app answer.
- When a store uninstalls the app (Apps page, the platform suspending it, the developer deleting it, or the app's own revoke), ZIMOS POSTs `{ event: "app.uninstalled", store_id, install_id, reason, uninstalled_at }` with `X-Zimos-Hmac-Sha256` = hex HMAC-SHA256 of the raw body with the client secret; retried for up to a day until it answers 2xx. Not sent on a re-approval. `reason`: `uninstalled_by_store` | `suspended_by_platform` | `app_deleted` | `revoked_by_app`.
- Screen: the developer's app form — «لينك إلغاء التثبيت» / "Uninstall URL" with the hint «بنبعتله لما متجر يشيل تطبيقك» / "We call it when a store removes your app" (+ link to the README).

## 269. WhatsApp sign-in — changes to item 262 — UI: pending

- `POST /auth/login/whatsapp/request` now always answers 200 `{ challengeToken, channel: "phone", sentTo }` — no 429/503 any more (the limit and a failed delivery answer the same way, nothing sent). Wording: «بعتنا كود على واتساب أو رسالة لـ {sentTo}» / "We sent a code by WhatsApp or SMS to {sentTo}".
- `POST /auth/login/whatsapp/verify` can now also answer `{ twoFactorRequired, challengeToken, channel: "email" }` for a browser new to the account (the same new-device email code as the password sign-in) → finish with `POST /auth/two-factor/verify`. A new-sign-in alert email goes out as for a password sign-in.

## 273–274. Points, credit and gift cards on refunds, cancels and rejections — UI: pending

- Changing an order's status back from cancelled / rejected (`PATCH /orders/:id/status`) or correcting a rejection to confirmed can now answer 409 `ORDER_TENDER_RETURNED` when the points, store credit or gift card it used were already given back: «النقاط / الرصيد / كارت الهدية رجعوا للعميل لما الطلب اتلغى — اعمل طلب جديد» / "The points, store credit or gift card went back to the customer when this was cancelled — place a new order".
- A COD order rejected on the confirmation call now gives its points / credit / gift card back (it shows as refunds on the order).
- A refund that doesn't pick a payment on a COD order is a cash refund; to give points / credit / a gift card back, pick that payment in the refund form.

## 278. Verified emails for shopper sign-in — UI: pending

- `GET /store/:ws/account/me` → `customer.emailVerified`. Only a verified email signs in by email code or Google.
- `POST /store/:ws/account/email/code` `{ email, locale }` (signed in) → `{ sent, target, expiresInSeconds, resendAfterSeconds }`; `POST /store/:ws/account/email/verify` `{ email, code }` → the account (`emailVerified: true`). 422 `INVALID_CODE` / `CODE_EXPIRED`, 429 `TOO_MANY_ATTEMPTS` / `TOO_MANY_CODES`.
- `POST /store/:ws/account/google` with the `x-shopper-token` header (signed in) links Google: `{ token, linked: true, customer }`. Without it, a Google email that isn't verified on an account answers 404 `ACCOUNT_NOT_FOUND`: «ادخل برقم موبايلك الأول، وبعدين ضيف جوجل من حسابك» / "Sign in with your phone first, then add Google from your account".
- Screens: Account → profile: next to the email «مش متأكد» / "Not verified" + «أكّد الإيميل» / "Verify email" (code sent to it, 6-digit input) and «اربط حساب جوجل» / "Link Google"; «متأكد ✓» / "Verified" once done. Changing the email shows it unverified again.

## 279. Google sign-in nonce — UI: pending (storefront)

- `GET /store/:ws/account/google` now also returns `nonce`. Pass it to Google Identity Services: `google.accounts.id.initialize({ client_id, nonce, callback })`, and fetch a fresh config (nonce) each time the sign-in button is shown — it lasts 10 minutes. A token without this store's fresh nonce is refused (401 `GOOGLE_TOKEN_INVALID`: «جرّب تاني» / "Try again" → refetch the config).
- Sandbox tokens (dev only): `sandbox:<email>:<subject>:<nonce>`.

## 275. Quotes — accept once, exact prices — UI: pending (small)

- `POST /store/:ws/quotes/:id/accept` answered twice (double click, a retry) now makes one order: the second answers 409 `QUOTE_NOT_OPEN`. Storefront: on that code, reload the quote (`GET /store/:ws/quotes/:id?token=…`) and, when it shows `accepted` with an `orderId`, show the success state instead of an error: «تم قبول العرض وطلبك اتسجل» / "Quote accepted — your order is placed".
- The order's total is now exactly the quote's `totalAmount` plus shipping: the store's automatic discount and quantity-bundle tiers no longer apply on top. Any "you save" line next to the quote total can go.
- Decline / cancel / answer on a quote that was just accepted answer 409 (`QUOTE_NOT_OPEN` for the shopper, `QUOTE_CLOSED` for the team): reload the quote and show its state.

## 287. Order self-service address change — UI: pending (small)

- `POST /store/:ws/orders/:orderId/self-service/address` `{ token?, address: { country?, province, city, area?, addressLine, placeId?, postalCode?, notes? } }`: the new address replaces the old one field by field — anything left out is cleared. Prefill the form with the current address (`order.shippingAddress`) so a shopper who changes only the street keeps their area and notes; send every field.
- New optional fields: `postalCode` (≤ 20) «الرمز البريدي» / "Postal code", `notes` (≤ 500) «ملاحظات للمندوب» / "Notes for the courier".

## 294. Packing slips — pieces, skipped orders — UI: pending (small)

- `POST /workspaces/:ws/orders/documents/packing-slips?as=base64` now answers `{ filename, contentType, base64, printed, skipped: [orderId] }` (the PDF form has the header `X-Skipped-Orders: <count>`). Cancelled orders get no slip. When `skipped` is not empty, show «اتشال {n} طلب ملغي» / "{n} cancelled order(s) left out".
- Only cancelled orders selected → 422 `NO_ORDERS_SELECTED` (`details.skipped`): «الطلبات دي ملغية» / "These orders are cancelled".
- The slip's price column is now «المبلغ» / "Amount" (the line's total); offer lines show their pieces and a bundle's contents. Nothing to change in the UI besides the wording if the preview labels the columns.

## 295. Bulk stock and price update — safer apply — UI: pending (small)

- `POST /workspaces/:ws/catalog/bulk-update/apply`: send an `Idempotency-Key: <uuid>` header (one new key per upload; reuse it on a retry). A second click with the same key gets the first answer, or 409 `IDEMPOTENCY_KEY_IN_PROGRESS` while it still runs: «لسه بيتنفذ — استنى ثواني» / "Still applying — wait a few seconds".
- Preview: a change can carry `warnings: [{ code: "BELOW_RESERVED", reserved }]` → a yellow note on the row: «الكمية أقل من المحجوز لطلبات مفتوحة ({reserved})» / "Below what open orders hold ({reserved})". With stock locations, a row that would take the main location below zero is in `errors` with its message.
- `stock_change` is applied as a change on the stock at that moment, so the preview's "to" can differ from the result when orders come in meanwhile.

## 297. Bulk update sheets — amounts and columns — UI: pending (small)

- `POST …/catalog/bulk-update/preview` (and apply) now answer `ignoredColumns: ["name", …]` (+ `summary.ignoredColumns`): show «الأعمدة دي مش هتتغير: {list}» / "These columns are not updated: {list}".
- Amounts may be typed "249.50" or "249,50"; the row error for an unclear amount reads "price must be an amount like 249.50 (at most 2 decimals)" — show it as is, or «اكتب السعر زي 249.50» / "Type the price like 249.50".
- A damaged .xlsx answers 422 `VALIDATION_ERROR` on `file`: «الملف بايظ — احفظه تاني أو ابعته CSV» / "The file is damaged — save it again or send a CSV".

## 293. Store reports — date ranges — UI: pending (small)

- Every `/workspaces/:ws/store-reports/*` report now takes `from` / `to` as a day: `?from=2026-09-01&to=2026-09-30` means 1–30 September in the store's time zone, both days included. Send the date picker's days as YYYY-MM-DD (no time, no "Z"). Full ISO timestamps still work as before (`to` exclusive).
- `from` after `to` → 422 `VALIDATION_ERROR` on `from`: «تاريخ البداية بعد تاريخ النهاية» / "The start date is after the end date".

## 298. Order email test sends — UI: pending (small)

- `POST /workspaces/:ws/order-emails/:key/test` `{ to? }`: `to` must be your own email or a team member's; otherwise 422 on `to`: «الإيميل التجريبي بيروح لك أو لحد من فريق المتجر بس» / "Test emails go to you or a member of your team". Prefill `to` with the signed-in user's email (or a team picker).
- 429 `TOO_MANY_TEST_EMAILS` after 50 a day: «وصلت لحد الإيميلات التجريبية النهارده» / "You've reached today's test email limit".

## 304. Webhook custom header values — UI: pending (small)

- `customHeaders[].value` on create / update now refuses non-Latin text and control characters (422 on `customHeaders.N.value`). Hint under the value field: «إنجليزي وأرقام ورموز بس — زي مفتاح API» / "Latin letters, digits and symbols only — like an API key".

## 305. Buy a domain — availability — UI: pending (small)

- Search and buy can answer 503 `DOMAIN_PURCHASE_UNAVAILABLE` (no registrar connected on this server): hide or disable «اشتري دومين» / "Buy a domain" and show «شراء الدومين مش متاح دلوقتي — اربط دومين عندك» / "Buying a domain isn't available yet — connect one you own" with a link to Connect domain.
- Buying needs a name like mystore.com on .com .net .store .shop .online .co; anything else → 422 on `domain`.

## 312. Funnels on a locked store — UI: pending (storefront)

- On funnel pages, send the header `X-Funnel-Id: <funnelId>` on every `/store/:ws/...` call the funnel's checkout makes (places, payment methods, shipping quote, delivery estimate / slots, checkout sessions, uploads, checkout). With a "coming soon" or password store whose funnels stay open, those calls then work; without the header they answer 423 `STORE_LOCKED` unless the body / query already carries `funnelId`.
- No change for the store's own pages: they show the gate as before.

## 302. Checkout autosave — funnel and website — UI: pending (storefront)

- `POST /store/:ws/checkout-sessions` now accepts `funnelId` and `websiteId` (uuid, optional) beside `source`. Send `funnelId` from funnel checkouts and `websiteId` from the store's website pages. With them, a lost checkout gets that funnel's / website's own cart-recovery email, and the dashboard and Live View filters count it. No visible change.

## 303. GTM container — the store's own Google tags — UI: pending (small)

- `GET /workspaces/:ws/tracking-pixels/gtm/container` no longer includes the store's own Google pixels (they already run on the storefront; a copy in GTM counts twice). Ask for a GA4 / Google Ads id only when it is not set up as a Zimos pixel. The response header `X-Zimos-Skipped-Ids` lists ids left out ("none" otherwise): show «{ids} شغالين من زيموس مباشرة — مش هنحطهم في الملف عشان ميتحسبوش مرتين» / "{ids} already run from Zimos — left out of the file so nothing counts twice".

## 318. Send to supplier — in progress — UI: pending (small)

- `POST …/dropship/…/orders/:orderId/push` can answer 409 `DROPSHIP_PUSH_IN_PROGRESS` while the same order is already being sent: «الطلب بيتبعت للمورد دلوقتي — حدّث الصفحة بعد شوية» / "This order is being sent to the supplier — refresh in a moment". The order's Supplier card may show a reference `externalOrderId: "pending"` for a few seconds: show «جاري الإرسال…» / "Sending…".

## 320. Refund form — send an Idempotency-Key — UI: pending (small)

- `POST /workspaces/:ws/orders/:orderId/refunds`: generate one `Idempotency-Key` (uuid) when the refund dialog opens and send it with the request (and with a retry of that same request). A double click then makes one refund. A new dialog gets a new key. 409 `IDEMPOTENCY_KEY_IN_PROGRESS`: «الاسترجاع بيتنفذ — استنى ثواني» / "The refund is being processed — wait a few seconds".

## 322. Checkout autosave — funnel on every save — UI: pending (storefront, with 302)

- Send `funnelId` (funnel checkouts) or `websiteId` (store pages) on **every** `POST /store/:ws/checkout-sessions` save, not only the first: a save without them now clears them, so a visitor who moves from a funnel to the store's checkout is counted where they are.

## 325. Domain selling price with the platform's margin — UI: pending

No new endpoint; what changes in the existing ones (`/api/v1/workspaces/:ws/domains/*`, `domain.manage`):
- `GET /search`, `GET /purchases/:id/renew-quote`, and `price` on `GET /purchases` are now the **selling price**. That means the registrar's cost in the platform's selling currency (e.g. EGP) plus the platform's margin, rounded. Same shape `{ amount, currency }`, minor units. The registrar's cost is never sent to the dashboard.
- `POST /purchases` and `POST /purchases/:id/renew` keep confirming with `acceptPrice` = the price shown. A new error:
  - **503 `DOMAIN_PRICE_UNAVAILABLE`**: the price can't be worked out right now (no quote, or no exchange rate yet).
  - «سعر الدومين مش متاح دلوقتي — جرّب كمان شوية» / "This domain's price isn't available right now — try again in a bit".
- Search results can come back with `price: null` while `available: true` (a TLD the registrar didn't price). Show «السعر مش متاح» / "Price not available" and disable «اشتري».
- Screens: Store settings → Domains → «اشتري دومين» (search list, buy dialog) and «جدّد» (renew dialog). Format prices in the returned currency (EGP for Egypt), e.g. «735 ج.م في السنة» / "EGP 735 / year".

## 326. Domain owner details in the buy dialog (Dynadot) — UI: pending

All under `/api/v1/workspaces/:ws/domains` (`domain.manage`).
- **GET `/registrant`** → `{ "required": true, "contact": { "fullName": "Mona Ali", "organization": "Mona Store", "email": "mona@gmail.com", "phoneCountryCode": "20", "phone": "1001234567", "address1": "12 Tahrir St", "address2": null, "city": "Cairo", "state": "Cairo", "postalCode": "11511", "country": "EG" } | null }`.
  - `required` is false in the sandbox. There the form can be skipped.
- **POST `/purchases`** takes a new optional field `contact`, with the same fields as above:
  - required: `fullName` (2–100), `email`, `phoneCountryCode` (1–3 digits), `phone` (4–14 digits, national number without the leading 0), `address1` (≤100), `city` (≤60), `state` (≤60, the governorate), `postalCode` (2–20 letters/digits), `country` (ISO-2);
  - optional: `organization` (≤100) and `address2` (≤100).
  - If it's left out, the saved contact is used.
  - When `required` and nothing is saved → **422 `DOMAIN_CONTACT_REQUIRED`**: «أضف بيانات صاحب الدومين» / "Add the domain owner's details".
- New error codes on purchase and renew:
  - **502 `REGISTRAR_REFUSED`**: «شركة الدومينات رفضت الطلب — راجع البيانات وجرّب تاني» / "The domain registrar refused — check the details and try again". The message carries the registrar's reason.
  - **502 `REGISTRAR_UNAVAILABLE`**: «شركة الدومينات مش بترد دلوقتي — جرّب كمان شوية» / "The domain registrar isn't answering — try again shortly".
  - **503 `DOMAIN_PRICE_UNAVAILABLE`** also on renew (handoff 325).

### Screen: Store settings → Domains → «اشتري دومين» → buy dialog
- When `required` is true, add a step «صاحب الدومين» / "Domain owner", pre-filled from `GET /registrant` (or from the store's details the first time).
- Fields:

  | ar | en |
  |---|---|
  | الاسم بالكامل | Full name |
  | اسم الشركة (اختياري) | Company (optional) |
  | الإيميل | Email |
  | كود الدولة + الموبايل | Country code + phone (from the country select, e.g. +20) |
  | العنوان | Address |
  | المدينة | City |
  | المحافظة | Governorate / State |
  | الرقم البريدي | Postal code |
  | الدولة | Country |

- A note under the form: «الدومين هيتسجل باسمك وانت صاحبه. هيوصلك إيميل من الجهة المسؤولة عن الدومينات لتأكيد الإيميل — لازم تأكده خلال 15 يوم وإلا الدومين يتوقف.» / "The domain is registered in your name and you own it. You'll get an email from the domain authority to confirm your address — confirm it within 15 days or the domain is suspended."
- When saved details exist, show them as a summary with «تعديل» / "Edit".

## 330. Sign-in by email or username, confirm the email with a code, the confirmed-account gate, phone at sign-up — UI: pending

Two server switches, both off unless set to exactly `true`. Read them from **GET `/auth/signup-options`**, which now also answers `"confirmByCode": false, "phoneRequired": false`.
- `SIGNUP_CONFIRM_BY_CODE`: a new account is active and signed in at once and confirms its email with a 6-digit code typed in the dashboard. Off (today): the account is pending until the emailed link is followed, as the dashboard handles now. `REQUIRE_SIGNUP_VERIFICATION` (`verificationRequired`) still comes first when it is on.
- `REQUIRE_PHONE_AT_SIGNUP`: sign-up must send a phone.

### Endpoints
- **POST `/auth/login`** (public) `{ "identifier": "mona_store", "password": "…", "locale": "ar" }`. `identifier` is the email or the username, any case. The old `{ "email": "mona@gmail.com", "password": "…" }` still works. Every failure is 401 `INVALID_CREDENTIALS`, as before.
- **POST `/auth/register`**: `phone` (string, ≤32) is required while `phoneRequired`; otherwise optional.
  - Missing → 422 `VALIDATION_ERROR` `[{ "field": "phone", "message": "Enter your mobile number" }]`.
  - Not a mobile number → 422 on `phone`, "Enter a valid mobile number".
  - Stored normalised ("01012345678" → `"201012345678"`).
  - With `confirmByCode` the 201 answer is `{ "user": { "status": "active", … }, "accessToken": "…", "refreshToken": "…", "sessionId": "…", "expiresAt": "…", "emailCode": { "sent": true, "channel": "email", "target": "m***@gmail.com", "expiresAt": "2026-10-07T07:00:00Z", "resendAvailableAt": "2026-10-07T06:51:00Z" } }`. `emailCode` is `{ "sent": false }` when no code could be sent. Today's "register, then log in with the same credentials" keeps working.
- **GET `/auth/me`** adds `"confirmed": true|false`: the email (or phone) is confirmed.
- **POST `/auth/me/email/send-code`** (Bearer) `{ "locale": "ar" }` → 200 `{ "sent": true, "channel": "email", "target": "m***@gmail.com", "expiresAt": "…", "resendAvailableAt": "…" }`.
  - Works for an account confirmed by phone only (`confirmed` true, `user.emailVerifiedAt` null): it needs its email confirmed before it can be invited or given a console role, so offer "Send me a code" in account settings while `emailVerifiedAt` is null.
  - Errors: 409 `ALREADY_VERIFIED` (the email itself is confirmed); 503 `EMAIL_UNAVAILABLE`; 429 `RESEND_TOO_SOON` (`details.retryAfterSeconds`); 429 `VERIFICATION_LIMIT_REACHED`.
- **POST `/auth/me/email/confirm`** (Bearer) `{ "code": "123456" }` → 200 `{ "user": { …, "emailVerifiedAt": "…" }, "confirmed": true }`. No new tokens: the session goes on.
  - Errors: 422 `INVALID_CODE` (`details.attemptsLeft`); 422 `CODE_EXPIRED`; 422 `NO_ACTIVE_CODE`; 429 `TOO_MANY_ATTEMPTS`; 409 `ALREADY_VERIFIED`.
- **403 `EMAIL_NOT_VERIFIED`** `{ "error": { "code": "EMAIL_NOT_VERIFIED", "message": "Confirm your email address first. We can send you a code.", "details": { "email": "m***@gmail.com" } } }`. It is checked before the draft-store check. It comes from:
  - `POST /workspaces/:ws/start-trial` and `/activate-free-plan`;
  - `POST /workspaces/:ws/websites/:websiteId/publish` and `/revisions/:revisionId/rollback`;
  - `POST /workspaces/:ws/funnels/:funnelId/publish`, `/revisions/:revisionId/rollback` and `/resume`;
  - `POST /workspaces/:ws/funnels/bulk` with `action` `publish` or `resume`.
  - The quickstart HTML form asks for the code itself (nothing to build).
- **409 `INVITEE_NOT_CONFIRMED`** on `POST /workspaces/:ws/members` and `POST /workspaces/:ws/team/invite`, when the email belongs to an account that hasn't confirmed its email yet (a confirmed phone is not enough).
- **Store transfer** (`/workspaces/:ws/ownership-transfer`): `GET /candidates` leaves out members who haven't confirmed. `POST` → 409 `NEW_OWNER_NOT_CONFIRMED`.
- **Console** `POST /admin/admins`: 409 `USER_NOT_ACTIVE` now also for an active account that hasn't confirmed its email (a confirmed phone is not enough), with the message "That account has not confirmed its email yet. Try again once it has."
- **Google** `/auth/google/callback` → `/auth/callback?error=ACCOUNT_SUSPENDED` now also for a suspended account that was never linked to Google.

### Screens (merchant dashboard)
- **Sign in**: the field becomes «الإيميل أو اسم المستخدم» / "Email or username" (type text, autocomplete `username`). Send it as `identifier`.
  - On a wrong answer: «بيانات الدخول غلط» / "Incorrect sign-in details".
  - Offer «ابعت إيميل التأكيد تاني» / "Resend the email" only when the field has an "@".
- **Sign up**: the phone field is «رقم الموبايل» / "Mobile number" and required while `phoneRequired`. Otherwise keep «رقم الهاتف (اختياري)» / "Phone (optional)".
  - Show the 422 under the field: «اكتب رقم موبايل صحيح» / "Enter a valid mobile number".
  - With `confirmByCode`, go straight in. When `emailCode.sent`, open the code dialog at once, with the code already sent.
- **Banner** (app shell, while `confirmed === false`): «أكّد إيميلك عشان تقدر تنشر متجرك وتبدأ التجربة المجانية.» / "Confirm your email to publish your store and start your free trial." Button «ابعتلي كود» / "Send me a code" opens the dialog.
- **Code dialog** «أكّد إيميلك» / "Confirm your email":
  - Text: «بعتنا كود من 6 أرقام لـ {target}. صالح 10 دقايق.» / "We sent a 6-digit code to {target}. It's valid for 10 minutes."
  - Field «الكود» / "Code" (inputmode numeric, autocomplete `one-time-code`).
  - Buttons: «تأكيد» / "Confirm", and «ابعت كود جديد» / "Send a new code". The second is disabled until `resendAvailableAt`, with «تقدر تطلب كود جديد بعد {s} ثانية» / "You can ask for a new code in {s}s".
  - States:
    - wrong code: «الكود مش صحيح — فاضل {n} محاولات» / "That code isn't right — {n} tries left";
    - expired or none: «الكود انتهى — اطلب كود جديد» / "The code has expired — ask for a new one";
    - too many tries: «محاولات كتير — اطلب كود جديد» / "Too many tries — ask for a new one";
    - limit: «طلبت أكواد كتير — جرّب بعد شوية» / "Too many codes requested — try again later";
    - 503: «مش قادرين نبعت إيميلات دلوقتي — جرّب كمان شوية» / "We can't send emails right now — try again shortly".
  - Success: toast «تم تأكيد إيميلك» / "Your email is confirmed", reload `/auth/me` and hide the banner.
- **Any action answering `EMAIL_NOT_VERIFIED`** (go live / start the trial, publish or restore the website or a funnel, resume, bulk publish/resume): open the code dialog with `details.email` and send the same request again once confirmed.
- **Team → Invite**: `INVITEE_NOT_CONFIRMED` → «صاحب الإيميل ده لسه مأكدش حسابه — اطلب منه يأكده وبعدين ابعت الدعوة تاني» / "That person hasn't confirmed their account yet — ask them to confirm it, then invite them again".
- **Settings → Transfer store**: `NEW_OWNER_NOT_CONFIRMED` → «الشخص ده لسه مأكدش إيميله» / "That person hasn't confirmed their email yet".
- **Google callback page**: `ACCOUNT_SUSPENDED` → «الحساب ده موقوف» / "This account has been suspended".
- **Console (platform-admin) → Admins → Add**: show the `USER_NOT_ACTIVE` message as is, or «الحساب ده لسه مأكدش إيميله» / "That account hasn't confirmed its email yet".

## 331. Password reset that reveals nothing, per-IP sign-in limits, the review-form switch — UI: pending

Server settings, nothing for the UI to read except `reviewFormOpen` below: `PASSWORD_RESET_RATE_LIMIT_PER_HOUR` (10 per IP), `AUTH_IP_RATE_LIMIT_MAX` / `AUTH_IP_RATE_LIMIT_WINDOW_MS` (50 per 15 minutes per IP), `VERIFICATION_CODES_PER_IP_PER_HOUR` / `_PER_DAY` / `VERIFICATION_SMS_PER_IP_PER_DAY` (20 / 50 / 5), `REVIEWS_PUBLIC_SUBMISSION_ENABLED` (unset = open, any value but `true` closes the storefront review form), `PASSWORD_RESET_SMS_ENABLED` (off unless `true`; no screen uses SMS reset — build none).

### Endpoints
- **POST `/auth/password-reset/request`** (public) `{ "email": "mona@gmail.com", "locale": "ar" }` → 200 `{ "success": true }`, at once and the same for every address.
  - `locale` (`ar` | `en`, optional) is the email's language; unset, the account's dashboard language, else Arabic. Anything else → 422 `VALIDATION_ERROR` on `locale`.
  - The link (`{FRONTEND_URL}/reset-password?token=…`, unchanged) is valid **30 minutes** (was one hour), works once, and a newer one replaces the older. Past 3 links an hour or 10 a day for one account the answer is the same and nothing is sent.
  - 429 `RATE_LIMITED` "Too many requests": 10 requests per hour from one IP, or the per-IP sign-up / reset / resend budget below.
  - 503 `PASSWORD_RESET_UNAVAILABLE` "Password reset is not available right now. Try again later." (production server without `FRONTEND_URL`; the same for every address).
- **POST `/auth/password-reset/confirm`** `{ "token": "…", "newPassword": "…" }` → 200 `{ "success": true }`. Unchanged shape. Now it also: signs the account out everywhere (any access token stops at once), forgets remembered browsers, confirms an unconfirmed email and activates a pending account. 400 `INVALID_RESET_TOKEN` for an unknown, used, replaced or expired link.
- **POST `/auth/login`**: after 50 failed sign-ins in 15 minutes from one IP (whatever emails or usernames were typed) → 429 `RATE_LIMITED`, even with the right password, until the window passes. Successful sign-ins don't count.
- **POST `/auth/register`**, **POST `/auth/resend-verification`**, **POST `/auth/password-reset/request`**: together 50 requests per 15 minutes per IP → 429 `RATE_LIMITED`.
- **POST `/auth/me/email/send-code`**, `/auth/verify/send`: 429 `VERIFICATION_LIMIT_REACHED` as before (the per-IP ceilings are now server settings).
- **GET `/store/:workspaceId/products/:idOrSlug`** adds `"reviewFormOpen": true|false`.
- **POST `/store/:workspaceId/products/:productId/reviews`** (unchanged body `{ orderNumber, phone, rating, comment, photoIds }`): while closed, every request → 404 `{ "error": { "code": "NOT_FOUND", "message": "Not found" } }`. Open, it answers as today (201/200, 403 `REVIEW_NOT_VERIFIED`, 422 `REVIEW_PHOTO_INVALID`).

### Screens
- **Merchant dashboard → Forgot password**: send `locale` with the dashboard's language. Keep the one confirmation for every address and change it to «إذا كان هذا البريد الإلكتروني مسجّلًا لدينا، سيصلك رابط لتعيين كلمة مرور جديدة خلال دقائق. الرابط صالح لمدة 30 دقيقة ولمرة واحدة.» / "If this email is registered with us, a link to set a new password will arrive within minutes. The link is valid for 30 minutes and works once."
  - 429: «طلبات كتير من الشبكة دي — جرّب بعد شوية» / "Too many requests from this network — try again in a while".
  - 503: «إعادة تعيين كلمة المرور مش متاحة دلوقتي — جرّب كمان شوية» / "Password reset isn't available right now — try again shortly".
- **Merchant dashboard → Reset password** (`/reset-password?token=`):
  - `INVALID_RESET_TOKEN`: «الرابط ده انتهى أو اتستخدم قبل كده — اطلب رابط جديد» / "This link has expired or was already used — ask for a new one", with a link «اطلب رابط جديد» / "Ask for a new link" to Forgot password.
  - Success: «اتغيرت كلمة المرور، وخرجنا من حسابك على كل الأجهزة. سجّل دخولك بكلمة المرور الجديدة.» / "Your password is changed and you've been signed out on every device. Sign in with the new password." Then go to sign-in (clear any stored tokens).
- **Merchant dashboard → Sign in / Sign up / Resend the email**: on 429 `RATE_LIMITED` show «محاولات كتير من الشبكة دي — استنى ربع ساعة وجرّب تاني» / "Too many attempts from this network — wait 15 minutes and try again". Don't clear the form.
- **Storefront → product page → reviews**: when `reviewFormOpen` is false, hide «اكتب تقييمًا» / "Write a review" and the form; keep the rating and the approved reviews. If a submission answers 404 `NOT_FOUND`, hide the form and show «التقييمات مقفولة دلوقتي» / "Reviews are closed right now".

---
## 332. Account settings: change your name, email and phone with codes — UI: pending

One server switch: `PHONE_CHANGE_ENABLED` (off unless exactly `true`). Read it from **GET `/auth/me`**, which now also answers `"account": { "hasPassword": true, "phoneChange": false }`: `hasPassword` false is an account made through Google (it proves it is the owner with a code to its current email instead of a password).

Our existing endpoints are unchanged and keep working: `PATCH /auth/me/profile` (name, picture, language), the email change by link (`GET`/`POST`/`DELETE /auth/me/email`, `POST /auth/email-change/confirm`, the `/account/email-change?token=` page) and `/auth/verify-phone/*`. The account settings screen should move its email change to the code flow below; keep the link page for links already sent. If the code flow changes the email, any pending link change dies, and the other way round. One change to the link flow: **POST `/auth/me/email`** for an account with `hasPassword: false` now needs `"reauthCode": "123456"` (from `POST /auth/me/reauth-code`, below) beside `newEmail`; without it 422 `REAUTH_CODE_REQUIRED`, and the code errors as below (422 `INVALID_CODE` / `CODE_EXPIRED` / `NO_ACTIVE_CODE`, 429 `TOO_MANY_ATTEMPTS`). A password account sends `password` as before. A password reset now also cancels a pending link change.

All the endpoints below are Bearer, act on the signed-in account only, and share a limit of 20 changes an hour per account (with `PATCH /auth/me/username`): past it, 429 `RATE_LIMITED` "Too many requests". A wrong password is **422**, never 401, so it must not sign the dashboard out.

### Endpoints
- **PATCH `/auth/me/name`** `{ "fullName": "Mona Adel" }` → 200 `{ "user": { …, "fullName": "Mona Adel" } }`. Spaces are collapsed and control characters dropped.
  - 422 `INVALID_NAME` "The name must be 2 to 200 characters." `details: [{ "field": "fullName", "message": "2 to 200 characters" }]`.
- **POST `/auth/me/reauth-code`** `{ "locale": "ar" }` (only for `hasPassword: false`) → 200 `{ "sent": true, "channel": "email", "target": "m***@gmail.com", "expiresAt": "2026-10-07T07:26:44Z", "resendAvailableAt": "2026-10-07T07:17:44Z" }`. A 6-digit code to the current email, valid 10 minutes, 5 tries.
  - 409 `PASSWORD_REQUIRED` (the account has a password: ask for it instead); 503 `EMAIL_UNAVAILABLE`; 429 `RESEND_TOO_SOON` (`details.retryAfterSeconds`, a minute between codes); 429 `VERIFICATION_LIMIT_REACHED` (5 an hour, 10 a day).
- **POST `/auth/me/email-change`** `{ "newEmail": "mona.new@gmail.com", "currentPassword": "…", "locale": "ar" }` — or `"reauthCode": "123456"` instead of `currentPassword` for `hasPassword: false` → 200 `{ "sent": true, "channel": "email", "target": "m***@gmail.com", "expiresAt": "…", "resendAvailableAt": "…" }`. A code goes to the new address. Nothing changes yet.
  - The answer is the same when the new address belongs to another account; then no code ever arrives (don't tell the person anything else).
  - 422 `SAME_EMAIL` (field `newEmail`); 422 `INVALID_PASSWORD` "The current password is not right." (field `currentPassword`); 422 `REAUTH_CODE_REQUIRED` (field `reauthCode`); for a wrong `reauthCode`: 422 `INVALID_CODE` (`details.attemptsLeft`), 422 `CODE_EXPIRED`, 422 `NO_ACTIVE_CODE`, 429 `TOO_MANY_ATTEMPTS`; 503 `EMAIL_UNAVAILABLE`; 429 `RESEND_TOO_SOON` / `VERIFICATION_LIMIT_REACHED` as above; 422 `VALIDATION_ERROR` for a malformed email.
- **POST `/auth/me/email-change/confirm`** `{ "code": "123456" }` → 200 `{ "user": { …, "email": "mona.new@gmail.com", "emailVerifiedAt": "…" }, "accessToken": "…", "refreshToken": "…" }` (in cookie mode the refresh token goes into the cookie and is left out of the body, as at sign-in). Every other session has ended, the current access token included: **store the new tokens at once**. The old address gets a notice with no link.
  - 422 `INVALID_CODE` (`details.attemptsLeft`); 422 `CODE_EXPIRED`; 422 `NO_ACTIVE_CODE`; 429 `TOO_MANY_ATTEMPTS`; 409 `EMAIL_TAKEN` (someone took the address meanwhile).
- **POST `/auth/me/phone-change`** `{ "newPhone": "01022223333", "currentPassword": "…", "locale": "ar" }` (or `reauthCode`) → 200 `{ "sent": true, "channel": "sms", "target": "01******333", "expiresAt": "…", "resendAvailableAt": "…" }`. An SMS code to the new number.
  - While `phoneChange` is false: the same 200 for any request (`target` may be null) and nothing is sent — don't offer the button.
  - 422 `INVALID_PHONE` (field `newPhone`); 422 `SAME_PHONE`; 422 `PHONE_COUNTRY_NOT_SUPPORTED`; 422 `INVALID_PASSWORD` / `REAUTH_CODE_REQUIRED` / the code errors as above; 503 `SMS_UNAVAILABLE`; 429 `RESEND_TOO_SOON` / `VERIFICATION_LIMIT_REACHED`.
- **POST `/auth/me/phone-change/confirm`** `{ "code": "123456" }` → 200 `{ "user": { …, "phone": "201022223333", "phoneVerifiedAt": "…" } }`. The session goes on. Errors as for the email confirm; while off, always 422 `NO_ACTIVE_CODE`.
- **PATCH `/auth/me/username`**: unchanged, plus 429 `RATE_LIMITED` past the shared limit.

### Screens
- **Merchant dashboard → Account settings → Name** «الاسم» / "Name": save with `PATCH /auth/me/name` («حفظ» / "Save"; success toast «اتحفظ الاسم» / "Name saved"). Picture and language stay on `/auth/me/profile`. `INVALID_NAME` under the field: «الاسم لازم يكون من 2 لـ 200 حرف» / "The name must be 2 to 200 characters".
- **Account settings → Email** «البريد الإلكتروني» / "Email": the current address and a button «تغيير البريد» / "Change email" opening a two-step dialog.
  - Step 1 «البريد الجديد» / "New email" and, when `hasPassword`, «كلمة المرور الحالية» / "Current password"; otherwise a button «ابعتلي رمز على بريدي الحالي» / "Send a code to my current email" (`/auth/me/reauth-code`), then «الرمز اللي وصلك على بريدك الحالي» / "The code sent to your current email". Button «ابعت رمز للبريد الجديد» / "Send a code to the new email".
  - Step 2 «بعتنا رمز من 6 أرقام على {target}» / "We sent a 6-digit code to {target}", a code field, «تأكيد» / "Confirm", and «ابعت الرمز تاني» / "Send it again" disabled until `resendAvailableAt` with a countdown «تقدر تطلب رمز جديد بعد {s} ثانية» / "You can ask for a new code in {s} s" (resending repeats step 1's request, so keep the password or ask for a new reauth code).
  - Success: store the returned tokens, refresh `/auth/me`, toast «اتغير بريدك، وخرجنا من حسابك على باقي الأجهزة» / "Your email is changed and you've been signed out on your other devices".
  - Errors: `SAME_EMAIL` «ده بريدك الحالي بالفعل» / "This is already your email"; `INVALID_PASSWORD` under the password «كلمة المرور مش صحيحة» / "The password isn't right"; `REAUTH_CODE_REQUIRED` «اطلب رمز على بريدك الحالي واكتبه» / "Ask for a code to your current email and enter it"; `INVALID_CODE` «الرمز غلط — باقي {attemptsLeft} محاولات» / "Wrong code — {attemptsLeft} tries left"; `CODE_EXPIRED` / `NO_ACTIVE_CODE` / `TOO_MANY_ATTEMPTS` «الرمز ده مبقاش صالح — اطلب رمز جديد» / "This code is no longer valid — ask for a new one"; `EMAIL_TAKEN` «البريد ده مستخدم في حساب تاني» / "This email is used by another account"; `RESEND_TOO_SOON` «استنى شوية قبل ما تطلب رمز جديد» / "Wait a moment before asking for another code"; `VERIFICATION_LIMIT_REACHED` / `RATE_LIMITED` «طلبات كتير — جرّب بعد شوية» / "Too many requests — try again later"; `EMAIL_UNAVAILABLE` «مش قادرين نبعت رموز على البريد دلوقتي — جرّب كمان شوية» / "We can't send email codes right now — try again shortly".
- **Account settings → Mobile number** «رقم الموبايل» / "Mobile number": when `account.phoneChange` is true, a button «تغيير الرقم» / "Change number" with the same two steps (new number «الرقم الجديد» / "New number", password or reauth code, then «بعتنا رمز في رسالة على {target}» / "We texted a code to {target}"); success «اتغير رقمك» / "Your number is changed" (no new tokens). When false, show the number as today with no change button.
  - Errors: `INVALID_PHONE` «اكتب رقم موبايل صحيح» / "Enter a valid mobile number"; `SAME_PHONE` «ده رقمك الحالي بالفعل» / "This is already your number"; `PHONE_COUNTRY_NOT_SUPPORTED` «مش بنبعت رموز للدولة دي» / "We can't send codes to this country"; `SMS_UNAVAILABLE` «مش قادرين نبعت رسائل دلوقتي — جرّب كمان شوية» / "We can't send text messages right now — try again shortly"; the password and code errors as for the email.

---
## 333. The Subscription section (plans, code preview, charges, plan change), one trial per account, the feature catalogue and its gate — UI: pending

One server switch: `PLAN_FEATURE_ENFORCEMENT` (off unless exactly `true`). The UI never reads it: it handles 403 `PLAN_FEATURE_REQUIRED` wherever it can appear (below). Everything under `/workspaces/:workspaceId/billing` is Bearer + `billing.manage` (the owner and the accountant role); amounts are minor units, like everywhere else. Prices always come from the server: the dashboard never sends one.

### Endpoints (merchant)
- **GET `/workspaces/:workspaceId/billing/plans`** → 200
  ```json
  {
    "subscription": { "status": "trialing", "billingCycle": "monthly", "planId": "c3bc…", "trialEndsAt": "2026-10-20T18:14:13Z", "currentPeriodEnd": "2026-10-20T18:14:13Z", "draft": false },
    "trial": { "available": false, "used": false },
    "planChange": "immediate",
    "referralCode": null,
    "plans": [
      { "id": "6538…", "name": "Growth", "currency": "USD", "monthlyPrice": 79900, "yearlyPrice": 799000, "trialDays": 14,
        "maxStores": null, "maxFunnelsPerMonth": null, "softOrderQuota": 2000, "features": ["custom_domain", "staff_accounts"],
        "isCurrent": false, "isPublic": true,
        "prices": { "monthly": { "gross": 79900, "discount": 0, "net": 79900 }, "yearly": { "gross": 799000, "discount": 0, "net": 799000 } } }
    ]
  }
  ```
  - `plans`: the plans on offer in the pricing page's order, plus the store's own first when it is a private plan (`isPublic: false` — show it, but it can't be chosen). `prices.*.discount` is what the attached referral code takes off (`referralCode` is the existing merchant view of it: `code`, `discountType`, `discountValue`, `discountCurrency`, `active`).
  - `trial.available`: the store is a draft (REQUIRE_SUBSCRIPTION_TO_GO_LIVE) and the account never had a free trial. `trial.used`: the account had one, on any plan or store — one per account now.
  - `planChange`: `immediate` (a draft or a trial: nothing paid yet → POST `/billing/plan`) or `support` (a paid subscription: through support).
- **POST `/workspaces/:workspaceId/billing/code-preview`** `{ "code": "ahmed10" }` → 200 `{ "code": { "code": "AHMED10", "discountType": "percentage", "discountValue": 1000, "discountCurrency": null, "active": true }, "plans": [{ "planId": "6538…", "prices": { "monthly": { "gross": 79900, "discount": 7990, "net": 71910 }, "yearly": { "gross": 799000, "discount": 79900, "net": 719100 } } }] }`. Attaches nothing: the code is attached with the existing **POST `/billing/referral-code`**.
  - 422 `REFERRAL_CODE_INVALID` "That referral code isn't valid. Check it and try again." (unknown or inactive, the same answer); 409 `SELF_REFERRAL` (the merchant's own code); 429 `RATE_LIMITED` (20 tries a minute per IP); 422 `VALIDATION_ERROR` (empty code).
- **GET `/workspaces/:workspaceId/billing/invoices?page=1&pageSize=20`** (pageSize ≤ 50) → 200 `{ "invoices": [{ "id": "…", "status": "paid", "periodStart": "2026-08-01T00:00:00Z", "periodEnd": "2026-09-01T00:00:00Z", "grossAmount": 29900, "discountAmount": 0, "amountDue": 29900, "amountPaid": 29900, "currency": "USD", "paidAt": "2026-09-01T00:00:00Z", "paymentSource": "manual", "createdAt": "…" }], "page": 1, "pageSize": 20, "total": 3 }`, newest first. `status`: `pending` | `paid` | `failed`.
- **POST `/workspaces/:workspaceId/billing/plan`** `{ "planId": "6538…", "billingCycle": "yearly" }` (`billingCycle` optional, keeps the current one) → 200 `{ "changed": true, "plans": { …the GET /billing/plans answer… } }`; `changed: false` when nothing changed. Takes effect at once; a trial keeps its end date.
  - 409 `PLAN_CHANGE_NEEDS_SUPPORT` "Your plan can be changed through Zimos support while a paid subscription runs. Contact support."; 422 `PLAN_NOT_AVAILABLE` (field `planId`: a private, inactive or unknown plan); 409 `OPEN_CHARGE_EXISTS` "A charge is open for the current plan. Settle it before changing plan."
- **POST `/workspaces/:workspaceId/start-trial`** now takes an optional body `{ "planId": "6538…" }` (no body = the store's own plan, as today). The store moves to that plan and its trial runs that plan's `trialDays` from now. 201 / 200 and the answer as today.
  - 422 `PLAN_NOT_AVAILABLE` (field `planId`); 409 `TRIAL_NOT_AVAILABLE` `details: { "reason": "used" | "no_trial", "days": 14 }` — `used` now means the account had a trial on any plan; 409 `NOT_A_DRAFT`, 403 `EMAIL_NOT_VERIFIED` as before.
- Changed shapes: **GET `/plans/public`**, **GET `/workspaces/:id/billing`** (`subscription.plan.features` and `features`) list only features that exist (today `priority_support` is never listed). The order of `/plans/public` is unchanged (display order, then price, then name).

### Endpoints (console)
- **GET `/admin/plans`** (plans.view) → 200 `{ "plans": [ … ], "featureCatalog": [{ "key": "custom_domain", "type": "boolean", "available": true, "label": { "en": "Custom domain", "ar": "نطاق خاص" } }, …, { "key": "priority_support", "type": "boolean", "available": false, "label": { "en": "Priority support", "ar": "دعم ذو أولوية" } }] }`. Plans now come in the pricing page's order (display order, then monthly price, then name), no longer by price alone. Read the feature list and its names from `featureCatalog` instead of a list in the console.
- **POST `/admin/plans`**, **PATCH `/admin/plans/:planId`** (plans.manage): a key the plan didn't list before must be `available` → 422 `PLAN_FEATURE_NOT_AVAILABLE` "Not available yet, so it can't be added to a plan: Priority support", `details: [{ "field": "features", "key": "priority_support", "message": "\"Priority support\" isn't available yet" }]` (an unknown key: `"\"bogus\" isn't a feature"`). A key the plan already lists can stay or be removed.
- **GET `/admin/workspaces/:workspaceId/features`**: each row of `features` adds `available` and `label { en, ar }`.

### The gate (while `PLAN_FEATURE_ENFORCEMENT=true`)
403 `{ "error": { "code": "PLAN_FEATURE_REQUIRED", "message": "Your plan doesn't include Custom domain. Upgrade your plan to use it.", "details": { "feature": "custom_domain", "label": { "en": "Custom domain", "ar": "نطاق خاص" } } } }` on:
- `custom_domain`: **POST `/workspaces/:id/domains`**, **POST `/domains/:domainId/verify`**, **POST `/domains/purchases`**;
- `staff_accounts`: **POST `/workspaces/:id/members`**, **POST `/workspaces/:id/team/invite`**;
- `advanced_analytics`: **GET `/workspaces/:id/analytics/web/stats`**, `/web/series`, `/web/metrics`, `/web/weekly`, `/web/realtime`.
Everything else stays open (domain list and settings, members, the analytics summary, overview, live view and reports). A console grant on the store lets it through without changing its plan.

### Screens
- **Merchant dashboard → Settings → Subscription** «الاشتراك» / "Subscription":
  - A cycle switch «شهري» / "Monthly" · «سنوي (شهرين مجانًا)» / "Yearly (2 months free)"; one card per plan with its name, `prices[cycle].net` per month / year, the gross struck through when `discount > 0` with «خصم الكود {amount}» / "Code discount {amount}", the plan's limits and its features by name (the same Arabic/English names as the console catalogue).
  - The current plan: badge «باقتك الحالية» / "Your current plan"; a private current plan shows «باقة خاصة» / "Private plan" and no button.
  - Other plans while `planChange` is `immediate`: «اختار الباقة دي» / "Choose this plan" → POST `/billing/plan` with the plan and the switch's cycle; success toast «اتغيرت باقتك» / "Your plan is changed", redraw from `plans`. While `support`: no button, a note «لتغيير الباقة أثناء اشتراك مدفوع تواصل مع الدعم» / "To change plan while a paid subscription runs, contact support" with a link «افتح تذكرة دعم» / "Open a support ticket".
  - While `trial.available`: on each plan with `trialDays > 0` «ابدأ تجربة مجانية {trialDays} يوم» / "Start a {trialDays}-day free trial" → POST `/start-trial` `{ planId }`. When `trial.used`: «استخدمت التجربة المجانية قبل كده» / "You've already used your free trial" and only the subscribe/pay actions.
  - Referral code «كود الإحالة» / "Referral code": a field and «جرّب الكود» / "Try the code" (code-preview) that redraws the prices with the discount, then «استخدم الكود» / "Use this code" (the existing attach). Once attached, show it read-only with its discount.
  - Charges «الفواتير» / "Charges": a table — period «الفترة» / "Period", amount «المبلغ» / "Amount" (gross, discount, due), paid «المدفوع» / "Paid", status «مدفوعة» / "Paid" · «في الانتظار» / "Pending" · «فشلت» / "Failed", paid on «تاريخ الدفع» / "Paid on"; paged 20 at a time, «لا توجد فواتير بعد» / "No charges yet" when empty.
  - Errors: `REFERRAL_CODE_INVALID` «الكود ده مش صالح — راجعه وجرّب تاني» / "That code isn't valid — check it and try again"; `SELF_REFERRAL` «مينفعش تستخدم كود الإحالة بتاعك على متجرك» / "You can't use your own referral code on your store"; `RATE_LIMITED` «محاولات كتير — استنى دقيقة وجرّب تاني» / "Too many tries — wait a minute and try again"; `PLAN_NOT_AVAILABLE` «الباقة دي مش متاحة دلوقتي» / "This plan isn't available right now"; `OPEN_CHARGE_EXISTS` «فيه فاتورة مفتوحة على باقتك الحالية — ادفعها الأول» / "There's an open charge on your current plan — settle it first"; `PLAN_CHANGE_NEEDS_SUPPORT` as the note above; `TRIAL_NOT_AVAILABLE` `used` «استخدمت التجربة المجانية قبل كده» / "You've already used your free trial", `no_trial` «الباقة دي مالهاش تجربة مجانية» / "This plan has no free trial".
- **Draft store → subscribe dialog**: may offer the other plans' trials with `planId`; the same errors.
- **Wherever the gated actions are** (Domains → add / verify / buy, Team → invite, Analytics → Website traffic): on 403 `PLAN_FEATURE_REQUIRED` show «باقتك مش فيها {label.ar} — رقّي باقتك عشان تستخدمها» / "Your plan doesn't include {label.en} — upgrade your plan to use it" with «شوف الباقات» / "See plans" → the Subscription section. Website traffic shows it in place of the charts.
- **Console → Plans → edit**: tick features from `featureCatalog` with `label.ar` / `label.en`; a key with `available: false` is disabled with «غير متاحة حاليًا» / "Not available yet", unless the plan already lists it (then it can be unticked, not re-ticked). Show `PLAN_FEATURE_NOT_AVAILABLE` details under the features. The list is in display order now.
- **Console → Store → Features**: use `label` for each row's name and mark `available: false` rows «غير متاحة حاليًا» / "Not available yet".

## 334. Paying the subscription by InstaPay or a wallet with a transfer proof, the platform's payment methods and their review in the console — UI: pending

No new environment variable. Online payment still needs `ONLINE_BILLING_ENABLED=true` and the `FAWATERAK_*` keys (docs/billing-fawaterak.md); a transfer needs a manual method turned on in the console with its number. Everything under `/workspaces/:workspaceId/billing` is Bearer + `billing.manage`; amounts are minor units; the dashboard never sends a price (`expectedAmount` is only compared). The whole contract is in docs/billing-payment-methods.md.

### Endpoints (merchant)
- **GET `/workspaces/:workspaceId/billing/payment-methods`** → 200, never cached:
  ```json
  {
    "methods": [
      { "code": "instapay", "kind": "manual", "label": { "ar": "إنستا باي", "en": "InstaPay" },
        "accountNumber": "zimos@instapay", "paymentLink": "https://ipn.eg/S/zimos/instapay/abc",
        "note": { "ar": "حوّل المبلغ بالضبط", "en": "Send the exact amount" } },
      { "code": "fawaterak", "kind": "gateway", "label": { "ar": "فواتيرك", "en": "Card / Fawry" } }
    ],
    "currency": "EGP",
    "contactSupport": false
  }
  ```
  In the console's order. A manual method is listed only for a plan in EGP and only with its number; `paymentLink` is `null` when none is set (show the number only); `note.ar` / `note.en` may be `null`. A gateway is listed only while it is turned on and configured. `methods: []` with `contactSupport: true` when there is no way to pay.
- **POST `/workspaces/:workspaceId/billing/invoices/open`** (no body) → always 200, writes nothing:
  ```json
  {
    "invoice": { "id": "next", "status": "pending", "periodStart": "2026-10-07T07:44:10Z", "periodEnd": "2026-11-07T07:44:10Z",
                 "grossAmount": 29900, "discountAmount": 0, "amountDue": 29900, "amountPaid": null, "currency": "EGP",
                 "paidAt": null, "paymentSource": null, "createdAt": null },
    "created": false,
    "written": false,
    "methods": [ …as GET /payment-methods… ]
  }
  ```
  `written: true` (and the charge's real `id` and `createdAt`) when a charge is already open; `id: "next"` otherwise — the charge is written only when a proof is sent. `amountDue` is what to transfer. 409 `NO_PAYMENT_METHOD` "There is no way to pay online or by transfer right now. Contact support."; 409 `NO_PLAN`, `PLAN_IS_FREE`.
- **POST `/workspaces/:workspaceId/billing/invoices/:invoiceId/payment-proofs`** — `multipart/form-data`, `:invoiceId` = the `invoice.id` from `/invoices/open` (`next` or a charge id):
  - `methodCode` (required): a manual method's `code`;
  - `senderPhone` (required): the Egyptian mobile number the money came from (`01012345678`, `0101 234 5678`, `+201012345678`);
  - `file` (required): the screenshot, JPEG, PNG or WebP, up to 8 MB;
  - `expectedAmount` (send it): the `amountDue` shown.
  → 201 `{ "proof": { "id": "a6a8…", "purpose": "invoice", "invoiceId": "e552…", "method": { "code": "instapay", "label": { "ar": "إنستا باي", "en": "InstaPay" } }, "senderPhone": "201012345678", "amount": 29900, "currency": "EGP", "status": "pending", "reviewNote": null, "createdAt": "…", "reviewedAt": null } }`.
  Errors: 409 `CHARGE_AMOUNT_CHANGED` `details: { "amountDue": 30900, "currency": "EGP" }` (show the new amount and ask again; nothing was written); 422 `PAYMENT_METHOD_NOT_AVAILABLE` (field `methodCode`); 422 `INVALID_SENDER_PHONE` (field `senderPhone`); 422 `NO_FILE`; 415 `UNSUPPORTED_MEDIA_TYPE`; 413 `FILE_TOO_LARGE`; 409 `PROOF_IMAGE_DUPLICATE`; 409 `PROOF_ALREADY_OPEN`; 409 `TOO_MANY_OPEN_PROOFS` (3 waiting per store); 409 `CHARGE_NOT_PENDING`; 409 `MANUAL_PAYMENT_CURRENCY_UNSUPPORTED`; 409 `NOTHING_TO_PAY`; 404 `NOT_FOUND` (an unknown charge id); 429 `RATE_LIMITED` (10 an hour per account).
- **GET `/workspaces/:workspaceId/billing/payment-proofs`** → 200 `{ "proofs": [ …the proof above… ] }`, the latest 20, newest first; `status` `pending` | `approved` | `rejected`; `reviewNote` is set only on a rejected one (the console's note, for the merchant).
- **POST `/workspaces/:workspaceId/billing/payments`** (the Pay button) takes an optional `"method": "fawaterak"`: a gateway from the list. Without it, Fawaterak as today. 404 `PAYMENT_METHOD_NOT_AVAILABLE` for a code that isn't an offered gateway.

### Endpoints (console)
- **GET `/admin/payment-methods`** (payments.record) → 200
  ```json
  {
    "methods": [
      { "id": "aad8…", "code": "instapay", "kind": "manual", "labelAr": "إنستا باي", "labelEn": "InstaPay", "sortOrder": 10, "enabled": true,
        "accountNumber": "zimos@instapay", "paymentLink": "https://ipn.eg/S/zimos/instapay/abc", "noteAr": "حوّل المبلغ بالضبط", "noteEn": "Send the exact amount",
        "offered": true, "updatedAt": "…" },
      { "id": "6f99…", "code": "fawaterak", "kind": "gateway", "labelAr": "Fawaterak", "labelEn": "Fawaterak", "sortOrder": 30, "enabled": true,
        "gateway": { "name": "Fawaterak", "adapterInstalled": true, "configured": false,
                     "missing": ["ONLINE_BILLING_ENABLED", "FAWATERAK_CLIENT_ID", "FAWATERAK_CLIENT_SECRET", "FAWATERAK_HASH_KEY", "FAWATERAK_WEBHOOK_TOKEN"],
                     "currencies": ["EGP"] },
        "offered": false, "updatedAt": "…" }
    ],
    "gatewaysNotAdded": [{ "code": "fawaterak", "name": "Fawaterak", "configured": false, "missing": ["…"], "currencies": ["EGP"] }]
  }
  ```
  `missing` holds variable names only. A gateway in `gatewaysNotAdded` has no row yet: turning it on (PATCH below) adds it.
- **PATCH `/admin/payment-methods/:code`** (payment_methods.manage) `{ "enabled": true, "labelAr": "…", "labelEn": "…" }` (any of them) → 200 `{ "method": { …one row as above… } }`. 409 `PAYMENT_METHOD_NEEDS_NUMBER` "Set the number this method sends money to before turning it on."; 404 for an unknown code.
- **PUT `/admin/payment-methods/order`** (payment_methods.manage) `{ "codes": ["wallet", "instapay"] }` → 200, the GET answer. 422 `UNKNOWN_PAYMENT_METHOD`.
- **PATCH `/admin/payment-methods/:code/account`** (payment_methods.edit_numbers) `{ "accountNumber": "zimos@instapay", "paymentLink": "https://ipn.eg/S/zimos/instapay/abc", "noteAr": "…", "noteEn": "…" }` (any of them; `""` clears one, `paymentLink: null` too) → 200 `{ "method": … }`. 422 `VALIDATION_ERROR` field `paymentLink` (not https); 409 `PAYMENT_METHOD_NEEDS_NUMBER` "Turn this method off before removing its number."; 409 `NOT_A_MANUAL_METHOD` (a gateway).
- **GET `/admin/payment-proofs?status=pending&page=1&pageSize=20`** (payments.record; `status` pending | approved | rejected | all; pageSize ≤ 50) → 200 `{ "proofs": [{ "id": "…", "purpose": "invoice", "workspace": { "id": "…", "name": "Demo Store", "slug": "demo-store" }, "invoiceId": "…", "method": { "code": "instapay", "labelAr": "إنستا باي", "labelEn": "InstaPay" }, "receivingNumber": "zimos@instapay", "senderPhone": "201012345678", "requestedAmount": 29900, "receivedAmount": null, "currency": "EGP", "status": "pending", "reviewNote": null, "reviewedBy": null, "reviewedAt": null, "submittedBy": { "id": "…", "fullName": "Demo", "email": "demo@zimos.test" }, "createdAt": "…" }], "page": 1, "pageSize": 20, "total": 1 }`. Waiting ones oldest first, the rest newest first.
- **GET `/admin/payment-proofs/:proofId`** (payments.record) → 200 `{ "proof": { … }, "invoice": { "id": "…", "status": "pending", "amountDue": 29900, "currency": "EGP", "periodStart": "…", "periodEnd": "…", "paidAt": null }, "approvalBlockers": [], "image": { "url": "https://api…/api/v1/payment-proofs/…/image?expires=…&signature=…", "expiresAt": "…", "mime": "image/jpeg" } }`. `image.url` works in an `<img>` without the token for 5 minutes (load the proof again for a new one). `approvalBlockers`: `CHARGE_ALREADY_PAID`, `CHARGE_REPRICED`.
- **POST `/admin/payment-proofs/:proofId/approve`** (payments.record) `{ "receivedAmount": 29900 }` → 200, the GET answer plus `"alreadyApproved": false` (`true` when it was already approved: nothing done again). 422 `RECEIVED_AMOUNT_MISMATCH` `details: { "requestedAmount": 29900, "receivedAmount": 29899, "currency": "EGP" }`; 409 `CHARGE_ALREADY_PAID`, `CHARGE_REPRICED`, `PROOF_ALREADY_REVIEWED`.
- **POST `/admin/payment-proofs/:proofId/reject`** (payments.record) `{ "note": "…" }` (3–1000 characters, the merchant reads it) → 200, the GET answer plus `"alreadyRejected"`. 409 `PROOF_ALREADY_REVIEWED` (approved).
- The two new platform keys `payment_methods.manage` and `payment_methods.edit_numbers` are held through `*` (the creator) unless granted: show them in the permission editor like the others.

### Screens
- **Merchant dashboard → Settings → Subscription → «ادفع» / "Pay"** opens a dialog from POST `/invoices/open`:
  - The amount «المبلغ المطلوب» / "Amount due" (`amountDue`, with the discount line when `discountAmount > 0`) and the period «الفترة» / "Period".
  - One tab or radio per method in `methods`. A gateway: «ادفع أونلاين» / "Pay online" → POST `/billing/payments` `{ lang, method: code }` and the existing redirect.
  - A manual method: «حوّل {amountDue} على {label.ar}» / "Transfer {amountDue} via {label.en}", the number «رقم التحويل» / "Send to" with a copy button «نسخ» / "Copy", «افتح لينك الدفع» / "Open the payment link" when `paymentLink` is set, the note. Then a form: «رقم الموبايل اللي حوّلت منه» / "The mobile number you sent from", «صورة التحويل (سكرين شوت)» / "Transfer screenshot" (JPEG, PNG or WebP, up to 8 MB), and «أرسل إثبات التحويل» / "Send the transfer proof" → the multipart POST with `expectedAmount`. Success: «وصلنا إثبات التحويل — هنراجعه ونأكدلك» / "We received your transfer proof — we'll check it and confirm".
  - Empty (`NO_PAYMENT_METHOD` / `contactSupport`): «مفيش طريقة دفع متاحة دلوقتي — تواصل مع الدعم» / "No way to pay is available right now — contact support" with «افتح تذكرة دعم» / "Open a support ticket".
  - Errors: `CHARGE_AMOUNT_CHANGED` «المبلغ اتغير لـ {amountDue} — راجعه وابعت تاني» / "The amount changed to {amountDue} — check it and send again" (update the amount shown); `INVALID_SENDER_PHONE` «اكتب رقم موبايل مصري صحيح» / "Enter a valid Egyptian mobile number"; `NO_FILE` «ارفع صورة التحويل» / "Attach the transfer screenshot"; `UNSUPPORTED_MEDIA_TYPE` «الصورة لازم تكون JPEG أو PNG أو WebP» / "The screenshot must be JPEG, PNG or WebP"; `FILE_TOO_LARGE` «الصورة أكبر من 8 ميجا» / "The screenshot is larger than 8 MB"; `PROOF_IMAGE_DUPLICATE` «الصورة دي اتبعتت قبل كده — ابعت صورة التحويل ده» / "This screenshot was already sent — send the screenshot of this transfer"; `PROOF_ALREADY_OPEN` «فيه إثبات تحويل للفاتورة دي مستني المراجعة» / "A proof for this charge is already waiting for review"; `TOO_MANY_OPEN_PROOFS` «عندك 3 إثباتات مستنية المراجعة — استنى لما نراجعها» / "You have 3 proofs waiting for review — wait until we check them"; `RATE_LIMITED` «محاولات كتير — جرّب بعد شوية» / "Too many tries — try again later"; `PAYMENT_METHOD_NOT_AVAILABLE` «طريقة الدفع دي مش متاحة دلوقتي» / "This payment method isn't available right now" (reload the methods).
- **Settings → Subscription → «إثباتات التحويل» / "Transfer proofs"**: from GET `/payment-proofs` — date, method, amount, status «في المراجعة» / "Under review" · «اتقبل» / "Approved" · «اترفض» / "Rejected"; a rejected one shows «سبب الرفض: {reviewNote}» / "Reason: {reviewNote}" and «ادفع تاني» / "Pay again". Empty: «مفيش إثباتات تحويل» / "No transfer proofs".
- **Console → Billing → «طرق الدفع» / "Payment methods"**: a list in order with drag or up/down to reorder (PUT order); per row the labels, kind «تحويل يدوي» / "Manual transfer" · «بوابة دفع» / "Gateway", a switch «مفعّلة» / "On" (disabled without `payment_methods.manage`). A manual row: «الرقم» / "Number", «لينك الدفع (اختياري)» / "Payment link (optional)" (https only: «اللينك لازم يبدأ بـ https://» / "The link must start with https://"), «ملاحظة بالعربي» / "Note in Arabic", «ملاحظة بالإنجليزي» / "Note in English", editable with `payment_methods.edit_numbers` only. A gateway row: «مضبوطة» / "Configured" or «ناقصها: {missing}» / "Missing: {missing}". `gatewaysNotAdded` rows show «إضافة» / "Add" (PATCH with `enabled`). `PAYMENT_METHOD_NEEDS_NUMBER`: «حط الرقم الأول قبل ما تفعّلها» / "Set the number before turning it on" / «اقفلها الأول قبل ما تمسح الرقم» / "Turn it off before removing the number".
- **Console → Billing → «إثباتات التحويل» / "Transfer proofs"**: tabs «في الانتظار» / "Waiting" · «مقبولة» / "Approved" · «مرفوضة» / "Rejected" · «الكل» / "All", paged; columns store, method, sent to, sender, amount, date. A proof page: the screenshot (`image.url`), the charge, the blockers «الفاتورة اتدفعت خلاص» / "The charge is already paid" · «سعر الفاتورة اتغير» / "The charge was re-priced"; «قبول» / "Approve" with «المبلغ اللي وصل» / "Amount received" (prefilled empty; must equal the requested amount — `RECEIVED_AMOUNT_MISMATCH` «المبلغ اللي وصل لازم يساوي المطلوب بالظبط — ارفض الإثبات بملاحظة» / "The amount received must equal the amount asked — reject the proof with a note"); «رفض» / "Reject" with a required note «سبب الرفض (هيظهر للتاجر)» / "Reason (the merchant sees it)".

## 335. The prepaid balance: pay per order, top-ups by transfer proof, the balance and its ledger — UI: pending

One server switch: `WALLET_ENABLED` (off unless exactly `true`). Off, nothing below is offered: no fee is charged, no pay-per-order card, top-ups and choosing the plan answer 404 `WALLET_DISABLED`; `GET /billing/wallet` still answers, with `enabled: false` (show nothing then, unless `onFeePlan` is true: a store already on the plan sees its balance read-only). The limits are fixed on the server and come with the balance (`limits`): minimum top-up EGP 100, maximum EGP 20,000, 3 waiting, the overdraft EGP 10, the warning below 20 orders. Everything under `/workspaces/:workspaceId/billing` is Bearer + `billing.manage`; amounts are minor units (EGP piastres); the dashboard never sends a fee or a price. Contract: docs/billing-wallet.md.

### Endpoints (merchant)
- **GET `/workspaces/:workspaceId/billing/plans`** adds `payPerOrder`:
  ```json
  { "payPerOrder": { "available": true, "current": false, "plan": { "id": "d9b4…", "name": "Pay per order", "fee": 400, "currency": "EGP" } } }
  ```
  `available`: the card can be chosen now (switch on and a pay-per-order plan offered). `current`: the store is on it (then `plan` is its plan even with the switch off). `plan: null` → no card. The pay-per-order plan never appears in `plans`, `/plans/public` or sign-up; POST `/billing/plan` and `/start-trial` with its id answer 422 `PLAN_NOT_AVAILABLE`.
- **POST `/workspaces/:workspaceId/billing/pay-per-order`** (no body; a confirmed account) → 200 `{ "changed": true }` (`false` when already on it). From a draft or a trial only: the store is active at once, nothing to pay, a fee per order from the next order.
  - 409 `PLAN_CHANGE_NEEDS_SUPPORT` "Your plan can be changed through Zimos support while a paid subscription runs. Contact support."; 409 `OPEN_CHARGE_EXISTS` "A charge is open for the current plan. Settle it before changing plan."; 404 `NOT_FOUND` (no pay-per-order plan offered); 404 `WALLET_DISABLED`; 403 `EMAIL_NOT_VERIFIED`.
- **GET `/workspaces/:workspaceId/billing/wallet`** → 200, never cached:
  ```json
  {
    "wallet": {
      "enabled": true, "onFeePlan": true,
      "phase": "ok", "balance": 8600, "fee": 400, "ordersLeft": 24, "ordersBeforeOverdraft": 21, "overdraft": 1000, "currency": "EGP",
      "totalToppedUp": 9000,
      "month": { "fees": 400, "orders": 1, "timeZone": "Africa/Cairo" },
      "limits": { "minTopup": 10000, "maxTopup": 2000000, "maxOpenTopups": 3, "lowOrders": 20 }
    }
  }
  ```
  `phase`: `ok` · `low` (fewer than `limits.lowOrders` orders before the balance reaches zero) · `overdraft` (at or below zero, still selling) · `exhausted` (the next order is refused; the storefront is closed). `fee`, `ordersLeft`, `ordersBeforeOverdraft` are `null` when the store pays no fee. `balance` may be negative (down to `-overdraft`). `month`: this calendar month in Cairo, fees net of those given back and the orders behind them.
- **GET `/workspaces/:workspaceId/billing/wallet/ledger?page=1&pageSize=20`** (pageSize ≤ 50) → 200 `{ "entries": [{ "id": "…", "type": "order_fee", "amount": -400, "balanceAfter": -400, "currency": "EGP", "orderId": "c61e…", "orderNumber": "ORD-MUXTMDPM-D5448644", "paymentProofId": null, "note": null, "createdAt": "…" }], "page": 1, "pageSize": 20, "total": 8 }`, newest first. `type`: `topup` (note "Transfer (instapay)", `paymentProofId`) · `order_fee` · `order_fee_reversal` (note `order_cancelled` · `order_rejected` · `payment_expired` · `customer_blocked`) · `order_fee_recharge`. 422 `VALIDATION_ERROR` on a bad page size.
- **POST `/workspaces/:workspaceId/billing/wallet/topups`** — `multipart/form-data`: `requestedAmount` (minor units, what was sent), `methodCode` (a manual method from GET `/billing/payment-methods`), `senderPhone`, `file` (the screenshot, JPEG/PNG/WebP, ≤ 8 MB) → 201 `{ "proof": { "id": "c725…", "purpose": "topup", "invoiceId": null, "method": { "code": "instapay", "label": { "ar": "إنستا باي", "en": "InstaPay" } }, "senderPhone": "201012345678", "amount": 10000, "currency": "EGP", "status": "pending", "reviewNote": null, "createdAt": "…", "reviewedAt": null } }`. It shows in GET `/billing/payment-proofs` with `purpose: "topup"`.
  - 422 `TOPUP_AMOUNT_OUT_OF_RANGE` `details: { "min": 10000, "max": 2000000, "currency": "EGP" }`; 404 `WALLET_DISABLED`; and item 334's: 422 `PAYMENT_METHOD_NOT_AVAILABLE`, `INVALID_SENDER_PHONE`, `NO_FILE`; 415 `UNSUPPORTED_MEDIA_TYPE`; 413 `FILE_TOO_LARGE`; 409 `PROOF_IMAGE_DUPLICATE`, `TOO_MANY_OPEN_PROOFS` (3 proofs of any kind waiting), `TOO_MANY_OPEN_TOPUPS`; 429 `RATE_LIMITED`.
- **Orders while on the plan**: creating an order in the dashboard (or by the public API) that the balance can't pay answers 402 `WALLET_BALANCE_TOO_LOW` "Your Zimos balance is too low to take another order. Top it up from Subscription, then try again." `details: { "balance": -800, "fee": 400, "overdraft": 1000, "currency": "EGP" }`; nothing is created. Shoppers get the store's 423 `STORE_UNAVAILABLE` (the storefront already handles it).
- **GET `/workspaces/:workspaceId/access`** adds `wallet` (the same `phase`, `balance`, `fee`, `ordersLeft`, `ordersBeforeOverdraft`, `overdraft`, `currency`; `null` when the store pays no fee or the switch is off) and a third `reasons` value, `balance` (with `restricted: true`). Product and funnel creation stay open under `balance`.
- **GET `/me/stores/overview`**: a store's `alerts` may hold `{ "code": "balance_exhausted" }`.

### Endpoints (console)
- **POST `/admin/plans`**, **PATCH `/admin/plans/:planId`** (plans.manage) take `perOrderFee` (minor units, 0–100000; left out = kept), and every plan in GET `/admin/plans` carries `perOrderFee` (0 = none). 422 `PER_ORDER_FEE_NOT_ALLOWED` "A fee per order is only for a plan priced 0 a month, in EGP." (field `perOrderFee`). A plan with a fee is never a default, public-list or sign-up plan, whatever `isPublic` says; `isPublic: true` is what offers it as the merchant's pay-per-order card.
- **GET `/admin/workspaces/:workspaceId/wallet?page=1&pageSize=20`** (subscriptions.view) → 200 `{ "wallet": { …as the merchant's GET /billing/wallet… }, "ledger": { …as GET /billing/wallet/ledger… } }`.
- **Transfer proofs** (item 334's screens): `proof.purpose` is `invoice` or `topup`. For a top-up, GET `/admin/payment-proofs/:proofId` has `"invoice": null` and `"wallet": { "balance": -400, "currency": "EGP" }` (the balance now). **Approve** `{ "receivedAmount": 9000 }` credits **what arrived**, whatever was asked (no `RECEIVED_AMOUNT_MISMATCH` for a top-up), once; 422 `RECEIVED_AMOUNT_REQUIRED` "Enter the amount that arrived. If nothing arrived, reject the proof with a note." for 0. Reject as for a charge.

### Screens
- **Settings → Subscription → the pay-per-order card** (when `payPerOrder.plan`): «ادفع على قد طلباتك» / "Pay per order", «{fee} جنيه على كل طلب، من رصيدك المدفوع مقدمًا — من غير اشتراك شهري» / "EGP {fee} per order from your prepaid balance — no monthly fee". While `available` and not `current`: «اختار الدفع بالطلب» / "Switch to pay per order" (confirm dialog «هتتخصم {fee} جنيه من رصيدك مع كل طلب جديد، وتترجع لو الطلب اتلغى أو اترفض قبل الشحن» / "EGP {fee} comes off your balance with every new order, and goes back if the order is cancelled or rejected before it ships") → POST `/pay-per-order`. `current`: badge «باقتك الحالية» / "Your current plan". `PLAN_CHANGE_NEEDS_SUPPORT`: «تواصل مع الدعم عشان تغيّر لباقة الدفع بالطلب» / "Contact support to move to pay per order".
- **Settings → Subscription → «الرصيد» / "Balance"** tab (when `onFeePlan` or `enabled`): the balance (red when negative) «رصيدك: {balance} جنيه» / "Your balance: EGP {balance}"; «يكفي حوالي {ordersLeft} طلب» / "Enough for about {ordersLeft} orders"; this month «رسوم الشهر ده: {month.fees} جنيه على {month.orders} طلب» / "This month: EGP {month.fees} for {month.orders} orders"; «إجمالي الشحن: {totalToppedUp}» / "Topped up in total: {totalToppedUp}".
  - «اشحن رصيدك» / "Top up" → a dialog like item 334's transfer dialog with an amount field «المبلغ اللي حوّلته» / "Amount you sent" (min/max from `limits`: «من {min} لحد {max} جنيه» / "From EGP {min} to EGP {max}"), the method's number and link, sender phone, screenshot, «أرسل إثبات الشحن» / "Send the top-up proof". Success: «وصلنا إثبات الشحن — هيتضاف للرصيد بعد المراجعة» / "We received your top-up proof — it's added to your balance once checked". `TOPUP_AMOUNT_OUT_OF_RANGE`: «المبلغ لازم يكون من {min} لحد {max} جنيه» / "The amount must be between EGP {min} and EGP {max}"; `TOO_MANY_OPEN_TOPUPS` / `TOO_MANY_OPEN_PROOFS`: «عندك 3 إثباتات مستنية المراجعة — استنى لما نراجعها» / "You have 3 proofs waiting for review — wait until we check them"; other proof errors as in item 334.
  - The ledger table «حركة الرصيد» / "Balance activity": date, type «شحن» / "Top-up" · «رسوم طلب» / "Order fee" · «استرجاع رسوم» / "Fee returned" · «رسوم طلب (تاني)» / "Order fee (again)", the order number linking to the order, amount (+ green / − red), balance after; paged; empty «مفيش حركة لسه» / "No activity yet".
  - Waiting top-ups appear in «إثباتات التحويل» / "Transfer proofs" with «شحن رصيد» / "Balance top-up" as the purpose.
- **Dashboard banner** (from `access.wallet`, on every page): `low` «رصيدك قرب يخلص — يكفي {ordersBeforeOverdraft} طلب. اشحن دلوقتي» / "Your balance is running low — enough for {ordersBeforeOverdraft} orders. Top up now"; `overdraft` «رصيدك بالسالب — المتجر هيقف بعد {ordersLeft} طلب» / "Your balance is below zero — the store stops after {ordersLeft} more orders"; `exhausted` (or `reasons` has `balance`) «المتجر وقف يستقبل طلبات لأن الرصيد خلص — اشحن عشان يرجع» / "Your store stopped taking orders because the balance ran out — top up to reopen it", each with «اشحن رصيدك» / "Top up".
- **Orders → new order**: on 402 `WALLET_BALANCE_TOO_LOW` «رصيدك مش كفاية لطلب جديد — اشحن من الاشتراك وجرّب تاني» / "Your balance is too low for another order — top up from Subscription and try again".
- **All my stores**: alert `balance_exhausted` «الرصيد خلص — المتجر واقف» / "Balance ran out — store stopped".
- **Console → Plans → edit**: a field «رسوم الطلب (بالقرش)» / "Fee per order (piastres)", shown as EGP; hint «للباقة اللي سعرها الشهري 0 وبالجنيه بس» / "Only for a plan at 0 a month, in EGP"; `PER_ORDER_FEE_NOT_ALLOWED` under the field. The plans list shows «{fee} / طلب» / "{fee} / order" on such a plan.
- **Console → Store → «الرصيد» / "Balance"** panel (subscriptions.view): the balance, phase, fee, totals and the ledger (GET `/admin/workspaces/:id/wallet`).
- **Console → Transfer proofs → a top-up**: label «شحن رصيد» / "Balance top-up", «المطلوب: {requestedAmount}» / "Asked: {requestedAmount}", «الرصيد الحالي: {wallet.balance}» / "Balance now: {wallet.balance}", «قبول» / "Approve" with «المبلغ اللي وصل فعلًا» / "Amount that actually arrived" (any amount above 0; it is what gets credited — show «هيتضاف للرصيد {receivedAmount}» / "{receivedAmount} will be added to the balance").

## 336. Manual subscription pricing: paid, free or discounted — UI: pending

No new environment variable or setting. A platform admin activating a store's subscription by hand now says what the period costs the merchant: **paid** (the plan's price, as before and the default), **free** (a gift) or **discounted** (a percent off, or a fixed price per billing period). A free or discounted subscription is never charged at the plan's price: no charge can be written for it, and when its period runs out an hourly job moves it to `past_due` (the usual grace day, then the restriction) instead of renewing. Activate again with `paid` (or extend it) to go on. Amounts are minor units of the plan's currency.

### Endpoints (console)
- **GET `/admin/workspaces/:workspaceId/subscription`** (subscriptions.view): `subscription` adds
  ```json
  {
    "subscription": {
      "id": "2f34…", "plan": { "id": "c3bc…", "name": "Starter", "code": "starter" },
      "status": "active", "storedStatus": "active", "phase": "ok", "billingCycle": "monthly",
      "currentPeriodStart": "2026-10-07T08:16:28Z", "currentPeriodEnd": "2026-11-07T08:16:28Z", "source": "manual_admin", "draft": false,
      "pricingKind": "discounted", "discountPercent": 25, "priceOverrideAmount": null,
      "effectivePrice": 22425, "currency": "EGP", "pricingExpiredAt": null
    },
    "limits": { "…": "…" }, "openCharge": null, "history": [ ]
  }
  ```
  `pricingKind`: `paid` · `free` · `discounted`. `effectivePrice`: one billing period as the merchant pays it (0 when free). `discountPercent` (1–99) or `priceOverrideAmount` is set only on a discounted one. `pricingExpiredAt`: when a free or discounted period ran out and the job moved it to `past_due` (`null` otherwise).
- **POST `/admin/workspaces/:workspaceId/subscription/activate`** (subscriptions.manage) takes three more fields:
  ```json
  { "planId": "c3bc…", "duration": { "months": 1 }, "billingCycle": "monthly", "note": "Partner deal",
    "pricingKind": "discounted", "discountPercent": 25 }
  ```
  or `"pricingKind": "discounted", "priceOverrideAmount": 10000` (per billing period, less than the plan's price for that cycle), or `"pricingKind": "free"`. Left out = `paid`. → 201 `{ "change": { … }, "replayed": false, …the GET answer… }` (200 with `replayed: true` for the same Idempotency-Key, as before). Errors, 422 `VALIDATION_ERROR` with the field in `details`: `discountPercent` "Give a percent or a fixed amount, not both" (a discounted one with neither or both); `pricingKind` "A discount needs the discounted pricing" (a percent or an amount with paid or free); `priceOverrideAmount` "The amount must be more than zero and less than the plan price"; a percent outside 1–99 or an unknown `pricingKind` "Invalid body".
- **change-plan** keeps the pricing (a fixed price above the new plan's price counts as the plan's price); **extend** keeps it and clears `pricingExpiredAt` (a period that had run out runs again at its price); **end** ends the period now (the job then moves a free or discounted one to `past_due`).
- **GET `/admin/subscriptions`** (subscriptions.view): each row adds `pricingKind`, `discountPercent`, `priceOverrideAmount`, `effectivePrice`, `pricingExpiredAt`; `mrr` is now at the effective price (a free one 0, a free or discounted one whose period ran out 0); the answer adds the same total over paid rows only:
  ```json
  { "subscriptions": [ { "workspaceName": "Demo Store", "planName": "Starter", "status": "active", "pricingKind": "free", "effectivePrice": 0, "pricingExpiredAt": null, "mrr": 0, "mrrCurrency": null, "…": "…" } ],
    "mrr": 0, "mrrCurrency": null, "mrrByCurrency": {}, "paidOnly": { "mrr": 0, "mrrCurrency": null, "mrrByCurrency": {} } }
  ```
  The console overview's MRR follows the same rule.
- **POST `/admin/workspaces/:workspaceId/charges`** (payments.record) → 409 `MANUAL_PRICING` "This subscription is free or discounted by the platform, so it is not charged here." **GET `/admin/workspaces/:workspaceId/charges`** has `nextCharge: null` for such a store.
- Audit log: the manual actions' before/after carry `pricingKind`, `discountPercent`, `priceOverrideAmount`, and `metadata.pricing { kind, amount, currency }`; a new action `subscription.manual_pricing_expired` (no actor) when the job moves a free or discounted subscription to `past_due`.

### Endpoints (merchant)
- **GET `/workspaces/:workspaceId/billing`**: `nextCharge` is `null` while the subscription is free or discounted.
- **POST `/workspaces/:workspaceId/billing/invoices/open`**, **POST `/billing/invoices/next/payment-proofs`** and **POST `/billing/payments`** (Pay, while a gateway is on) → 409 `MANUAL_PRICING` "This subscription is free or discounted by the platform, so it is not charged here." Nothing is written or stored.

### Screens
- **Console → Store → Subscription → «تفعيل» / "Activate"** dialog: a choice «التسعير» / "Pricing": «مدفوع — سعر الباقة» / "Paid — the plan's price" (default) · «مجاني (هدية)» / "Free (gift)" · «بخصم» / "Discounted". With Discounted, a toggle «نسبة خصم» / "Percent off" (1–99, «٪» / "%") or «سعر ثابت للفترة» / "Fixed price per period" (in the plan's currency, less than the plan's price for the chosen cycle), and a line «التاجر هيدفع {price} كل {شهر|سنة}» / "The merchant pays {price} a {month|year}" worked out from the plan's price. Hint under Free and Discounted: «مفيش فواتير هتتعمل للاشتراك ده، ولما الفترة تخلص هيتحول لمتأخر في الدفع» / "No charges are made for this subscription; when the period ends it becomes past due". Field errors under the field (`details[].field`): «اختار نسبة أو سعر ثابت — واحد بس» / "Choose a percent or a fixed price — one of them"; «النسبة من 1 لـ 99» / "The percent must be 1 to 99"; «السعر لازم يكون أكبر من صفر وأقل من سعر الباقة» / "The price must be above zero and below the plan's price".
- **Console → Store → Subscription** panel: a badge by the plan — «مدفوع» / "Paid" · «مجاني» / "Free" · «خصم {discountPercent}٪» / "{discountPercent}% off" · «سعر خاص» / "Special price"; «السعر الفعلي: {effectivePrice} {currency}» / "Price paid: {effectivePrice} {currency}". When `pricingExpiredAt`: «انتهت الفترة المجانية/المخفّضة في {pricingExpiredAt} — فعّل الاشتراك أو مدّه» / "The free/discounted period ended on {pricingExpiredAt} — activate or extend it". The «إنشاء فاتورة» / "Create charge" button is off for a free or discounted store with the hint «الاشتراك مجاني أو بخصم من المنصة — مفيش فواتير» / "Free or discounted by the platform — no charges" (`MANUAL_PRICING` shows the same text).
- **Console → Subscriptions** list: a column «التسعير» / "Pricing" (the badge above) and «السعر الفعلي» / "Price paid"; the MRR header gets a switch «كل الاشتراكات» / "All subscriptions" · «المدفوعة بس» / "Paid only" (`paidOnly`).
- **Console → Audit log**: `subscription.manual_pricing_expired` «انتهت فترة التسعير اليدوي» / "Manual pricing period ended".
- **Merchant → Settings → Subscription**: with `nextCharge: null` hide the next-charge line. On `MANUAL_PRICING` from Pay or the pay dialog: «اشتراكك مجاني أو بخصم من زيموس — مفيش حاجة تدفعها هنا. لو الفترة خلصت تواصل مع الدعم» / "Your subscription is free or discounted by Zimos — there's nothing to pay here. If the period has ended, contact support", with «افتح تذكرة دعم» / "Open a support ticket".

## 337. Suspend, unsuspend and delete an account from the console; deleted accounts hidden from the user list — UI: pending

No new environment variable or setting. A platform admin with `workspaces.manage` (the store suspension's permission) can suspend a person's account (they can't sign in until it is lifted), lift the suspension, or delete the account. Deleting is soft: the row stays so its stores, orders and audit rows keep working, but the email, phone, name, username and picture are wiped, the password removed and every way back in closed. An account that owns stores is deleted only together with suspending those stores. Every call needs `confirm: true` (the console asks first) and is in the audit log. Nobody can do this to their own account, only a creator can do it to a creator's account, another console account (admin, agent) also needs `admins.manage`, and the last creator can't be suspended or deleted.

### Endpoints (console)
- **POST `/admin/users/:userId/suspend`** (workspaces.manage)
  ```json
  { "reason": "Fraud report from a carrier", "confirm": true }
  ```
  `reason` 2–500 characters, required. → 200
  ```json
  { "user": { "id": "4dee…", "status": "suspended", "suspendedAt": "2026-10-07T08:35:36Z", "suspendedReason": "Fraud report from a carrier", "deletedAt": null } }
  ```
  Every session of the account ends at once (it is signed out everywhere); its API keys and the partner apps it approved stop working until it is unsuspended.
- **POST `/admin/users/:userId/unsuspend`** (workspaces.manage)
  ```json
  { "reason": "Checked with the carrier", "confirm": true }
  ```
  `reason` optional (up to 500). → 200 `{ "user": { "id": "…", "status": "active", "suspendedAt": null, "suspendedReason": null, "deletedAt": null } }`. `status` is `pending_verification` instead when the account had not confirmed its email when it was suspended and still hasn't.
- **POST `/admin/users/:userId/delete`** (workspaces.manage)
  ```json
  { "reason": "Asked to be deleted", "stores": "suspend", "confirm": true }
  ```
  `reason` optional (up to 500); `stores: "suspend"` is required when the account owns any store, and suspends every active one it owns. → 200
  ```json
  { "user": { "id": "58ed…", "status": "suspended", "suspendedAt": "2026-10-07T08:35:38Z", "suspendedReason": "Asked to be deleted", "deletedAt": "2026-10-07T08:35:38Z", "suspendedStores": ["3ba3…"] } }
  ```
- Errors (all three): 422 `VALIDATION_ERROR` (no `confirm: true`, a reason too short or long, `stores` not `"suspend"`); 404 `NOT_FOUND` (no such account); 409 `CANNOT_ACT_ON_SELF` "You cannot do this to your own account."; 403 `CREATOR_REQUIRED` "Only a creator can act on a creator's account."; 403 `ADMINS_MANAGE_REQUIRED` "Only an admin who manages platform users can act on a console account." (the account has a console role and you lack `admins.manage`); 409 `LAST_CREATOR` "This is the last creator."; 409 `USER_ALREADY_SUSPENDED` (suspend); 409 `USER_NOT_SUSPENDED` (unsuspend); 409 `USER_DELETED` "This account was deleted." (any of the three on a deleted account); 409 `OWNS_STORES` with `details: [{ "field": "stores", "message": "Owns 2 store(s)" }]` (delete without `stores`); 403 without `workspaces.manage`.
- **GET `/admin/users?q=&page=&limit=&includeDeleted=`** (workspaces.view): deleted accounts are left out of `users` and `total` unless `includeDeleted=true`. Each row adds `"deleted": false|true`, and each of its store rows adds `"owner": true|false` (true only for the store's owner of record; a member on the Owner role has `role: "owner"` with `owner: false`). `includeDeleted` other than true/false → 422.
- **GET `/admin/users/:userId`** (workspaces.view): still opens a deleted account; `user` adds `"suspendedAt"`, `"suspendedReason"`, `"deletedAt"` (and `deleted`), beside `twoFactor` as before.
- Audit log (console): `user.suspend` (metadata `reason`, `sessionsRevoked`, `challengesClosed`), `user.unsuspend` (`reason`, `suspensionReason`), `user.delete` (`reason`, `suspendedStores`, and the counts of what was closed), and `workspace.suspend` with `metadata.ownerDeleted` for each store a deletion suspended.

### Endpoints (sign-in; dashboard and console login screens)
- **POST `/auth/login`** and the Google sign-in (`/auth/google/callback`): 401 `ACCOUNT_SUSPENDED` "This account has been suspended" (as before) and, new, 401 `ACCOUNT_DELETED` "This account was deleted" (Google, for a deleted account's Google login; a password sign-in to a deleted account is `INVALID_CREDENTIALS`, since its address and password are gone).
- A signed-in person whose account is suspended or deleted gets 401 `SESSION_ENDED` on the next call (then `ACCOUNT_INACTIVE`); refresh gives 401. Send them to the sign-in page.
- Partner apps: **POST `/oauth/token`** → 400 `invalid_grant` "The person who approved can no longer sign in" when the approver was suspended or deleted after approving.

### Screens
- **Console → Users → a user**: a status badge «نشط» / "Active" · «في انتظار التأكيد» / "Pending confirmation" · «موقوف» / "Suspended" · «محذوف» / "Deleted". When suspended: «موقوف من {suspendedAt}: {suspendedReason}» / "Suspended since {suspendedAt}: {suspendedReason}". When deleted: «الحساب ده اتمسح في {deletedAt} — البيانات الشخصية اتشالت» / "This account was deleted on {deletedAt} — its personal details were removed", and no action buttons. Buttons (only with `workspaces.manage`, and also `admins.manage` when the user has a `platformRole`; hidden on your own account): «إيقاف الحساب» / "Suspend account", «إلغاء الإيقاف» / "Lift suspension" (when suspended), «حذف الحساب» / "Delete account" (red).
- **Suspend dialog**: title «إيقاف الحساب؟» / "Suspend this account?"; text «الشخص ده مش هيقدر يسجل دخول، وهيتعمله تسجيل خروج من كل الأجهزة، ومفاتيح الـAPI والتطبيقات اللي وافق عليها هتقف لحد ما تلغي الإيقاف. متاجره مش هتتوقف.» / "This person won't be able to sign in and is signed out everywhere; their API keys and the apps they approved stop until you lift the suspension. Their stores keep running."; a required field «السبب» / "Reason" (2–500); buttons «إيقاف» / "Suspend" and «إلغاء» / "Cancel".
- **Lift suspension dialog**: «إلغاء إيقاف الحساب؟» / "Lift the suspension?", optional «ملاحظة» / "Note", «إلغاء الإيقاف» / "Lift suspension".
- **Delete dialog**: title «حذف الحساب نهائيًا؟» / "Delete this account for good?"; text «الإيميل والموبايل والاسم واسم المستخدم والصورة هيتمسحوا، والحساب مش هيقدر يدخل تاني. الطلبات والسجلات بتفضل. مفيش رجوع.» / "Email, phone, name, username and picture are wiped and the account can never sign in again. Orders and records stay. This can't be undone."; optional «السبب» / "Reason". When the user owns stores (its `workspaces` rows with `owner: true` — not `role: "owner"`, which a member kept on the Owner role also has), list them and a required checkbox «إيقاف متاجره ({n})» / "Suspend their stores ({n})" that sends `stores: "suspend"`; the button stays off until it is ticked. Buttons «احذف الحساب» / "Delete account" (red) and «إلغاء» / "Cancel". After it: «تم حذف الحساب وإيقاف {n} متجر» / "Account deleted and {n} store(s) suspended", {n} = the length of the answer's `suspendedStores` (an already suspended store is not counted). A 409 `OWNS_STORES` (ownership changed meanwhile) re-opens the dialog with the checkbox.
- Error texts: `CANNOT_ACT_ON_SELF` «مينفعش تعمل كده على حسابك» / "You can't do this to your own account"; `CREATOR_REQUIRED` «الحساب ده Creator — محتاج Creator يعمل كده» / "This is a creator's account — only a creator can do this"; `ADMINS_MANAGE_REQUIRED` «الحساب ده له صلاحيات في الكونسول — محتاج صلاحية إدارة المستخدمين» / "This is a console account — you need permission to manage platform users"; `LAST_CREATOR` «ده آخر Creator» / "This is the last creator"; `USER_ALREADY_SUSPENDED` «الحساب موقوف بالفعل» / "Already suspended"; `USER_NOT_SUSPENDED` «الحساب مش موقوف» / "Not suspended"; `USER_DELETED` «الحساب ده اتمسح» / "This account was deleted"; `OWNS_STORES` «الحساب ده بيملك متاجر — اختار إيقافها الأول» / "This account owns stores — choose to suspend them first".
- **Console → Users** list: deleted accounts are hidden; a toggle «إظهار الحسابات المحذوفة» / "Show deleted accounts" sends `includeDeleted=true`, and deleted rows show the «محذوف» / "Deleted" badge, greyed. Suspended rows show «موقوف» / "Suspended".
- **Console → Audit log**: `user.suspend` «إيقاف حساب» / "Account suspended", `user.unsuspend` «إلغاء إيقاف حساب» / "Suspension lifted", `user.delete` «حذف حساب» / "Account deleted".
- **Dashboard and console sign-in**: `ACCOUNT_SUSPENDED` «الحساب ده موقوف. تواصل مع الدعم» / "This account is suspended. Contact support"; `ACCOUNT_DELETED` «الحساب ده اتمسح» / "This account was deleted".

## 338. Console notifications for platform admins, with read state and settings — UI: pending

No new environment variable or setting. The console gets a bell: the server writes one notification per event (a sign-up, a new store, a subscription activated by hand or by a recorded payment, one ending within 7 days or ended, a payment proof sent, a failed subscription charge, a support ticket, a store joining with a referral code, an account suspended). Every console admin sees the same rows, but only the types their console permissions open (below), and each admin has their own read state and their own settings per type. Nothing is sent by email yet: the email switch is stored for later, and the settings answer `emailDelivery: false`.

Who sees which type (besides `overview.view`, which every call needs):

| `type` | needs | label |
|---|---|---|
| `user_signup` | workspaces.view | «تسجيل جديد» / "New sign-up" |
| `workspace_created` | workspaces.view | «متجر جديد» / "New store" |
| `user_suspended` | workspaces.view | «إيقاف حساب» / "Account suspended" |
| `subscription_activated` | subscriptions.view | «تفعيل اشتراك» / "Subscription activated" |
| `subscription_expiring` | subscriptions.view | «اشتراك قرّب يخلص» / "Subscription ending soon" |
| `subscription_expired` | subscriptions.view | «اشتراك خلص» / "Subscription ended" |
| `referral_signup` | subscriptions.view | «متجر بكود إحالة» / "Joined with a referral code" |
| `payment_failed` | subscriptions.view | «فشل دفع اشتراك» / "Subscription payment failed" |
| `payment_proof_submitted` | payments.record | «إثبات دفع جديد» / "Payment proof sent" |
| `support_ticket` | support.view | «تذكرة دعم جديدة» / "New support ticket" |

### Endpoints (console)
- **GET `/admin/notifications?type=&unread=&cursor=&limit=`** (overview.view). Newest first. `type` one of the ten above; `unread` `true`/`false` (or `1`/`0`); `limit` 1–50 (default 20); `cursor` is the previous page's `nextCursor`. Types the admin can't see or turned off are left out. → 200
  ```json
  {
    "notifications": [
      {
        "id": "5f0c…",
        "type": "payment_proof_submitted",
        "title": "Balance top-up proof sent",
        "body": null,
        "link": "/payment-proofs/8b1e…",
        "data": { "action": "payment_proof.submit", "entityId": "8b1e…", "purpose": "topup", "amount": 10000, "currency": "EGP" },
        "actorUserId": "9656…",
        "subjectUserId": null,
        "subjectUserName": null,
        "workspaceId": "0c20…",
        "workspaceName": "Demo Store",
        "createdAt": "2026-10-07T08:46:23.512Z",
        "readAt": null
      }
    ],
    "nextCursor": "MjAyNi0xMC0wN1Q…",
    "unread": 7
  }
  ```
  `title` is English and only a fallback: show the console's own text per `type` (below). `body` is free text when there is one (the note of a manual activation, the reason of a suspension, the failure reason of a charge). `link` is the console page it is about: `/users/{id}`, `/workspaces/{id}`, `/payment-proofs/{id}` or `/tickets/{id}` — map it to the console's routes. `data` per type: `user_signup` `method` (`password` / `google`); `workspace_created` —; `subscription_activated` `pricing { kind, amount, currency }` (a manual activation) or nothing (a recorded payment, `data.action` `billing_invoice.record_payment`); `subscription_expiring` / `subscription_expired` `subscriptionId`, `periodEnd`, `name`, `pricingKind` (from the hourly check), or `pricing` (a free or discounted period that ran out, `data.action` `subscription.manual_pricing_expired`); `payment_proof_submitted` `purpose` (`invoice` / `topup`), `amount` (minor units), `currency`; `payment_failed` `invoiceId`, `amount`, `currency`; `support_ticket` `subject`. Amounts are minor units, as everywhere in billing. 422 `VALIDATION_ERROR` for a bad `cursor` ("Invalid cursor"), an unknown `type` or a `limit` outside 1–50.
- **GET `/admin/notifications/unread-count`** (overview.view) → 200 `{ "unread": 7 }`. For the bell's badge; poll it (e.g. every 60 s) or refresh after any action.
- **POST `/admin/notifications/read`** (overview.view) — this admin only.
  ```json
  { "ids": ["5f0c…", "77a1…"] }
  ```
  or `{ "all": true }` (every unread one this admin can see). Exactly one of the two; `ids` up to 200 uuids. → 200 `{ "unread": 5 }`. Marking one already read changes nothing. 422 `VALIDATION_ERROR` for both, neither, or an id that is not a uuid.
- **GET `/admin/notification-prefs`** (overview.view) → 200
  ```json
  { "prefs": [ { "type": "user_signup", "enabled": true, "email": false }, { "type": "workspace_created", "enabled": true, "email": false } ], "emailDelivery": false }
  ```
  One row per type this admin can see, defaults filled in (shown in the console, no email).
- **PUT `/admin/notification-prefs`** (overview.view)
  ```json
  { "prefs": [ { "type": "user_signup", "enabled": false, "email": false } ] }
  ```
  1–10 rows; `type` and `enabled` required, `email` optional (default false). Only the types sent change. → 200, the same body as GET. A type turned off disappears from this admin's list and count (not other admins'); its rows are not deleted, turning it back on shows them again. 422 `VALIDATION_ERROR` for an unknown type, an empty list or a row without `enabled`.
- 401 without a token; 403 `FORBIDDEN` "Missing required platform permission: overview.view" without it.

### Screens
- **Console top bar → bell**: a badge with `unread` (hidden at 0, «+99» / "99+" above 99). Opening it shows the latest 10: an icon per type, the line below, the store or account name, the time ago («من 5 دقايق» / "5 min ago"), bold while unread. Clicking a row marks it read (`ids: [id]`) and opens its page (`link`). At the bottom: «تعليم الكل كمقروء» / "Mark all as read" (`all: true`) and «عرض الكل» / "See all". Empty: «مفيش إشعارات» / "No notifications".
- **Console → Notifications** (full page): tabs «الكل» / "All" and «غير المقروء» / "Unread" (`unread=true`), a type filter (the labels in the table, only the types from the settings call), «تحميل المزيد» / "Load more" while `nextCursor` is not null, and «تعليم الكل كمقروء» / "Mark all as read".
- Row lines (fall back to `title` for anything missing):
  - `user_signup`: «{subjectUserName} عمل حساب جديد» / "{subjectUserName} signed up"; with `method: google` add «بجوجل» / "with Google".
  - `workspace_created`: «متجر جديد: {workspaceName}» / "New store: {workspaceName}".
  - `user_suspended`: «تم إيقاف حساب {subjectUserName}: {body}» / "{subjectUserName}'s account was suspended: {body}".
  - `subscription_activated`: manual «تم تفعيل اشتراك {workspaceName} يدويًا ({pricing.kind})» / "{workspaceName}'s subscription was activated by hand ({pricing.kind})" with `body` as the note; recorded payment «اتسجل دفع لـ{workspaceName} والاشتراك اتفعّل» / "Payment recorded for {workspaceName}; subscription active". Pricing kind: `paid` «مدفوع» / "paid", `free` «مجاني» / "free", `discounted` «بخصم» / "discounted".
  - `subscription_expiring`: «اشتراك {workspaceName} هيخلص {periodEnd}» / "{workspaceName}'s subscription ends on {periodEnd}".
  - `subscription_expired`: «اشتراك {workspaceName} خلص» / "{workspaceName}'s subscription ended"; for `subscription.manual_pricing_expired` «الفترة المجانية أو المخفضة لـ{workspaceName} خلصت ومتجددتش» / "{workspaceName}'s free or discounted period ended and was not renewed".
  - `payment_proof_submitted`: `invoice` «{workspaceName} بعت إثبات دفع بـ{amount}» / "{workspaceName} sent a payment proof for {amount}"; `topup` «{workspaceName} بعت إثبات شحن رصيد بـ{amount}» / "{workspaceName} sent a balance top-up proof for {amount}".
  - `payment_failed`: «فشل دفع اشتراك {workspaceName} ({amount}): {body}» / "{workspaceName}'s subscription payment failed ({amount}): {body}".
  - `support_ticket`: «تذكرة جديدة من {workspaceName}: {data.subject}» / "New ticket from {workspaceName}: {data.subject}".
  - `referral_signup`: «{workspaceName} دخل بكود إحالة» / "{workspaceName} joined with a referral code".
- **Console → Settings → Notifications**: one row per type from GET `/admin/notification-prefs` (only the ones this admin can see), the label from the table, two switches «في الكونسول» / "In the console" (`enabled`) and «بالإيميل» / "By email" (`email`). While `emailDelivery` is false, show under the email column «الإيميل لسه مش بيتبعت — اختيارك هيتحفظ» / "Email isn't sent yet — your choice is kept". Save sends the changed rows; then «تم حفظ الإعدادات» / "Settings saved".
- Errors: «الصفحة دي محتاجة صلاحية على الكونسول» / "This page needs a console permission" (403); «حصل خطأ، جرّب تاني» / "Something went wrong, try again" for anything else.

## 339. Marketing-site traffic for the console, linked to the account at sign-up — UI: pending

Three places: the marketing site (zimos.co) sends anonymous beacons, the dashboard's sign-up passes on which site visit it came from, and the console shows the traffic and, per account, where it came from. Server settings (names only in `.env.example`): `SITE_ANALYTICS_ENABLED` (on only when exactly `true`; off today) and `SITE_ANALYTICS_ORIGINS` (the site's origins, comma-separated, e.g. `https://zimos.co,https://www.zimos.co`, no trailing slash). The clients need no switch of their own: while it is off the beacon answers 404 and sign-up ignores `siteSessionId`, so both can always be sent. Nothing identifies a person: no IP and no cookie is stored, only an HMAC of the browser's random id and the day.

### Endpoints
- **POST `/public/site-events`** (public, no token, no cookies; only from an origin in `SITE_ANALYTICS_ORIGINS`). Send the body as `text/plain` (no preflight) or `application/json`, at most 2 kb:
  ```json
  { "visitorId": "8c1f2a9e-4b7d-4c0e-9a51-2f3d6e7b8a90", "sessionId": "b2e4c6d8-1a3f-4e5b-8c7d-9e0f1a2b3c4d", "event": "view", "path": "/pricing", "locale": "ar", "referrer": "https://www.google.com/", "utmSource": "facebook", "utmMedium": "cpc", "utmCampaign": "launch" }
  ```
  - `visitorId`, `sessionId`: 8–64 letters, digits or `-` (a `crypto.randomUUID()` fits). `event`: `view`, `ping` or `cta_click`. `path`: starts with `/`, ≤300 (no query string needed). `locale` `ar`/`en`, `referrer` ≤500, `utm*` ≤100 each: all optional. Any other key → 422.
  - → **204** with no body. Known crawlers also get 204 and nothing is kept.
  - Errors (log them, never show them): 403 `ORIGIN_NOT_ALLOWED` (origin not listed, or none); 422 `VALIDATION_ERROR` (`details[].field`); 413 `PAYLOAD_TOO_LARGE`; 400 `INVALID_JSON`; 429 `RATE_LIMITED` (120 a minute per IP); 404 `ROUTE_NOT_FOUND` while the server has it off.
- **POST `/auth/register`** adds an optional `"siteSessionId": "b2e4c6d8-1a3f-4e5b-8c7d-9e0f1a2b3c4d"` (same 8–64 rule; anything else → 422 on `siteSessionId`). The answer is unchanged; the link is made on the server and never fails the sign-up, and an unknown session just links nothing.
- **GET `/admin/site-traffic/summary?range=today|7d|30d`** (console, `overview.view`; default `today`; anything else → 422). Days are UTC days, `today` included. → 200
  ```json
  {
    "enabled": true,
    "range": "7d",
    "since": "2026-10-01T00:00:00.000Z",
    "visits": 3,
    "uniqueVisitors": 2,
    "avgSecondsOnSite": 8,
    "topPages": [ { "path": "/pricing", "visits": 1 }, { "path": "/features", "visits": 1 } ],
    "topSources": [ { "source": "facebook", "sessions": 1 }, { "source": "direct", "sessions": 1 } ],
    "funnel": { "visit": 2, "ctaClick": 1, "signup": 1 },
    "daily": [ { "day": "2026-10-01", "visits": 0, "uniqueVisitors": 0 }, { "day": "2026-10-07", "visits": 3, "uniqueVisitors": 2 } ]
  }
  ```
  `visits` counts page views; `funnel` counts sessions (viewed, clicked a sign-up button, signed up). `topSources[].source` is the session's first `utmSource`, else the referrer's host, else `direct`. Top lists hold at most 10. `daily` has one row per day of the range. Answered whether collection is on or off (`enabled`). 401 without a token, 403 `FORBIDDEN` without `overview.view`.
- **GET `/admin/users/:userId`** (console, `workspaces.view`): `user` adds `acquisition`, `null` or
  ```json
  { "landingPath": "/pricing", "referrerHost": "www.google.com", "utmSource": "facebook", "utmMedium": "cpc", "utmCampaign": "launch", "firstVisitAt": "2026-10-07T08:54:11.021Z", "signedUpAt": "2026-10-07T08:54:11.542Z", "secondsBeforeSignup": 1 }
  ```

### Marketing site (zimos.co)
- `visitorId`: made once and kept in `localStorage`. `sessionId`: made per visit and kept in `sessionStorage` (a new tab or a new day starts a new one).
- `view` on every page shown (route changes too), with `path` and `locale`; `referrer` (`document.referrer`) and the `utm_source` / `utm_medium` / `utm_campaign` of the address only on the session's first view.
- `ping` every 15 s while the tab is visible (`document.visibilityState === "visible"`), with the current `path`. The server counts 15 s per ping whatever the client says.
- `cta_click` when a sign-up / "start free" button is clicked, with the current `path`.
- Send with `navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: "text/plain" }))` (or `fetch` with `keepalive: true`, `credentials: "omit"`, `Content-Type: text/plain`). Fire and forget; never block the page on it.
- Every link to the dashboard's sign-up adds `?sv={sessionId}`.

### Dashboard sign-up
- Read `sv` from the address on the sign-up page (keep it in `sessionStorage` if the visitor moves between sign-up steps) and send it as `siteSessionId` on POST `/auth/register` when it matches `^[A-Za-z0-9-]{8,64}$`; otherwise leave it out. Nothing is shown to the visitor. Google sign-up does not carry it.

### Screens (console)
- **Console → Site traffic** «زيارات الموقع» / "Site traffic" (only with `overview.view`). Tabs «النهارده» / "Today", «آخر 7 أيام» / "Last 7 days", «آخر 30 يوم» / "Last 30 days" (`range`).
  - Tiles: «الزيارات» / "Visits" (`visits`), «زوار مختلفين» / "Unique visitors" (`uniqueVisitors`, with the note «الزائر بيتحسب مرة في اليوم» / "A visitor is counted once per day"), «متوسط الوقت على الموقع» / "Average time on site" (`avgSecondsOnSite` as m:ss).
  - Funnel: «زيارة» / "Visit" → «ضغط على زرار التسجيل» / "Clicked sign-up" → «عمل حساب» / "Signed up", with each step's share of the first.
  - «أكتر الصفحات زيارة» / "Top pages" (path, visits) and «مصادر الزيارات» / "Top sources" (source, sessions; `direct` shown as «مباشر» / "Direct").
  - A daily chart of visits and unique visitors from `daily`.
  - `enabled: false`: a banner «تتبع زيارات الموقع مقفول على السيرفر — الأرقام دي من قبل ما يتقفل» / "Site traffic collection is off on the server — these numbers are from before it was turned off". Everything zero: «لسه مفيش زيارات في الفترة دي» / "No visits in this period yet".
- **Console → Users → a user**: a card «جه منين» / "Where they came from": «أول صفحة» / "Landing page" (`landingPath`), «المصدر» / "Source" (`utmSource`, else `referrerHost`, else «مباشر» / "Direct"), «الوسيط» / "Medium" (`utmMedium`), «الحملة» / "Campaign" (`utmCampaign`), «أول زيارة» / "First visit" (`firstVisitAt`), «اتسجل بعد {duration} من أول زيارة» / "Signed up {duration} after the first visit" (`secondsBeforeSignup`). Empty fields are hidden. `acquisition: null`: «مفيش بيانات — اتسجل من غير ما يعدي على الموقع، أو قبل ما التتبع يشتغل» / "No data — signed up without going through the site, or before tracking was on".
- Errors: «الصفحة دي محتاجة صلاحية على الكونسول» / "This page needs a console permission" (403); «حصل خطأ، جرّب تاني» / "Something went wrong, try again" for anything else.

## 340. Store manual payments by InstaPay or wallet with a screenshot proof — UI: pending

A second kind of manual payment, beside the existing "manual transfer with a receipt" (Settings → Payments → manual transfers, `/manual-transfers`, unchanged). Here the merchant lists InstaPay accounts and wallet numbers; the shopper picks one at checkout, the order is placed unpaid, and they send the number they paid from and a screenshot afterwards. Staff approve or reject it; until it is approved the order can't be confirmed or shipped. No new environment variable and no setting key: a store opts in by adding a method. The store's payment rules apply to it as the `bank_transfer` method (its fee or discount, and a funnel's method list by `store_method:<id>`). Amounts are minor units.

### Endpoints (dashboard)
- **GET `/workspaces/:workspaceId/manual-payments/methods`** (`workspace.manage`) → 200, in the merchant's order:
  ```json
  { "methods": [
    { "id": "27793e5a-…", "kind": "wallet", "label": "Vodafone Cash", "accountNumber": "0101 234 5678", "paymentLink": null, "instructions": null, "active": true, "sortOrder": 0, "createdAt": "…", "updatedAt": "…" },
    { "id": "2ec548b1-…", "kind": "instapay", "label": "InstaPay", "accountNumber": "demo@instapay", "paymentLink": "https://ipn.eg/S/demo/instapay/abc", "instructions": "حوّل المبلغ بالظبط", "active": true, "sortOrder": 1, "createdAt": "…", "updatedAt": "…" }
  ] }
  ```
- **POST `/workspaces/:workspaceId/manual-payments/methods`** (`workspace.manage`) `{ "kind": "instapay", "label": "InstaPay", "accountNumber": "demo@instapay", "paymentLink": "https://ipn.eg/S/demo/instapay/abc", "instructions": "حوّل المبلغ بالظبط", "active": true }` → 201 `{ "method": { …as above… } }`. `kind` `instapay` | `wallet` and `label` (1–80) and `accountNumber` are required; `paymentLink` (https only, ≤500), `instructions` (≤1000), `active` (default true) and `sortOrder` optional. `""` or `null` for the link or the instructions = none (stored `null`). `accountNumber`: a wallet takes a phone number (8–15 digits, spaces, dashes and a leading + allowed, kept as typed); InstaPay takes a handle, phone or account number (3–80 of letters, digits, `@ . _ + -` and spaces). Errors: 422 `VALIDATION_ERROR` with `details[].field` `accountNumber` ("must be a wallet phone number" / "must be an InstaPay account or number"), `paymentLink` (not https), `label`, `kind`; 409 `TOO_MANY_PAYMENT_METHODS` (50 per store).
- **PATCH `/workspaces/:workspaceId/manual-payments/methods/:methodId`** (`workspace.manage`) — any of the fields above → 200 `{ "method": … }`. Changing `kind` re-checks the number (422 on `accountNumber`). 404 `NOT_FOUND` for another store's or an unknown id.
- **DELETE `/workspaces/:workspaceId/manual-payments/methods/:methodId`** (`workspace.manage`) → 204. Orders already placed with it keep their own copy of the method.
- **PUT `/workspaces/:workspaceId/manual-payments/methods/order`** (`workspace.manage`) `{ "ids": ["27793e5a-…", "2ec548b1-…"] }` (1–50, no repeats) → 200 `{ "methods": [ … ] }`. 404 when an id isn't this store's.
- **GET `/workspaces/:workspaceId/manual-payments/orders/:orderId`** (`orders.view`) → 200 `{ "manualPayment": null }` for an order not paid this way, else:
  ```json
  { "manualPayment": {
    "id": "7aff0470-…", "status": "submitted", "awaitingReview": true,
    "kind": "instapay", "label": "InstaPay", "accountNumber": "demo@instapay", "paymentLink": "https://ipn.eg/S/demo/instapay/abc",
    "payerNumber": "201011112222",
    "proofUrl": "https://api…/api/v1/customer-uploads/…?expires=…&signature=…", "proofUrlExpiresAt": "…",
    "submittedAt": "…", "reviewedAt": null, "reviewedByUserId": null, "rejectionReason": null
  } }
  ```
  `status`: `awaiting_proof` (nothing sent yet) → `submitted` → `approved` | `rejected` (the shopper may send again after a rejection). `payerNumber` is a phone as digits with the country code, or an InstaPay handle. `proofUrl` opens in an `<img>` without the token until `proofUrlExpiresAt` (load again for a new one). 404 for another store's or an unknown order.
- **POST `/workspaces/:workspaceId/manual-payments/orders/:orderId/approve`** (`orders.manage`, no body) → 200 `{ "manualPayment": { …status "approved"… } }`. The order becomes paid at its own total, and a captured payment (provider `manual`, method `bank_transfer`, the payer number as sender, the screenshot as receipt) appears in the order's `payments` and in GET `/manual-transfers/orders/:orderId`. 409 `MANUAL_PAYMENT_NOT_SUBMITTED` (nothing waiting for review, or already approved / rejected), `NO_MANUAL_PAYMENT` (the order wasn't paid this way), `ORDER_CANCELLED` (cancelled, or rejected on a confirmation call: reopen it first).
- **POST `/workspaces/:workspaceId/manual-payments/orders/:orderId/reject`** (`orders.manage`) `{ "reason": "المبلغ ناقص" }` (1–500, required; the shopper sees it) → 200 `{ "manualPayment": { …status "rejected", "rejectionReason": "المبلغ ناقص"… } }`. 409 as approve.
- **GET `/workspaces/:workspaceId/orders/:orderId`**: a `bank_transfer` order carries `manualPayment` (the object above, or `null` for one paid by our receipt transfer). **GET `/confirmation-tasks`**: such a task's `order.manualPayment` too.
- **POST `/orders/:orderId/confirmation`**, a queue outcome `confirmed` and a correction to `confirmed` answer 409 `MANUAL_PAYMENT_NOT_APPROVED` "Approve the payment proof before confirming this order" until it is approved. These orders are in the confirmation queue from the start.
- **PUT `/payment-rules`**: an `adjustments` rule on `bank_transfer` prices these orders too; `methodsByFunnel` lists may hold `store_method:<id>`.

### Endpoints (storefront, no login)
- **GET `/store/:ws/payment-methods`**: after the gateways, COD and the receipt-transfer methods (`manual:<id>`), one entry per active method:
  ```json
  { "id": "store_method:2ec548b1-…", "provider": "store_method", "method": "bank_transfer", "mode": "live", "name": "InstaPay",
    "manualPaymentMethodId": "2ec548b1-…", "kind": "instapay", "accountNumber": "demo@instapay", "paymentLink": "https://ipn.eg/S/demo/instapay/abc",
    "instructions": "حوّل المبلغ بالظبط", "proofAfterCheckout": true,
    "adjustment": { "type": "discount", "valueType": "percent", "value": 500, "label": "Transfer discount" } }
  ```
  (`adjustment` only when the store has a `bank_transfer` rule.) **GET `/store/:ws/manual-payment-methods`** gives the same methods alone: `{ "methods": [{ "id", "kind", "label", "accountNumber", "paymentLink", "instructions" }] }`.
- **POST `/store/:ws/checkout`** with `"paymentMethod": "bank_transfer", "manualPaymentMethodId": "2ec548b1-…"` (no `transfer`) → 201:
  ```json
  { "order": { "id": "…", "orderNumber": "ORD-…", "totalAmount": "23750", "paymentAdjustmentAmount": "-1250", "financialState": "pending", … },
    "manualPayment": { "orderId": "…", "orderNumber": "ORD-…", "totalAmount": 23750, "currency": "EGP", "status": "awaiting_proof", "rejectionReason": null, "submittedAt": null, "canSubmit": true,
                       "method": { "kind": "instapay", "label": "InstaPay", "accountNumber": "demo@instapay", "paymentLink": "https://ipn.eg/S/demo/instapay/abc", "instructions": "حوّل المبلغ بالظبط" } },
    "paymentToken": "q9…", "trackingToken": "…" }
  ```
  `paymentToken` is shown once: keep it (sessionStorage) for the proof page, as for an online payment. Errors: 422 `VALIDATION_ERROR` field `manualPaymentMethodId` ("is not a payment method this store offers": off, deleted or another store's; "is not allowed" with another `paymentMethod`); `transfer` and `manualPaymentMethodId` together 422; 422 `PAYMENT_METHOD_UNAVAILABLE` (not offered in this funnel); a gift card, points or store credit with it 422 (as for every `bank_transfer`).
- **GET `/store/:ws/orders/:orderId/manual-payment`** with header `X-Payment-Token` (the checkout's token, or the `pl_…` token of a message's payment link) → 200 `{ "manualPayment": { …as in the checkout answer… } }`; after a rejection `status: "rejected"`, `rejectionReason`, `canSubmit: true`. 404 for a wrong token or order.
- **POST `/store/:ws/orders/:orderId/manual-payment/proof`** with `X-Payment-Token`, `multipart/form-data`: `payerNumber` (the phone or InstaPay handle they paid from, e.g. `0101 111 2222` or `ahmed@instapay`) and `file` (JPEG, PNG or WebP, up to 15 MB; it is re-encoded without its metadata) → 201 `{ "manualPayment": { …"status": "submitted", "canSubmit": false… } }`. Errors: 422 `VALIDATION_ERROR` field `payerNumber`; 422 `NO_FILE`; 415 `UNSUPPORTED_MEDIA_TYPE`; 413 `FILE_TOO_LARGE`; 422 `IMAGE_UNREADABLE`; 413 `IMAGE_TOO_LARGE`; 409 `PROOF_ALREADY_SUBMITTED` (waiting for review or approved); 409 `ORDER_CANCELLED`; 404 (wrong token or order); 429 `RATE_LIMITED` (5 a minute per IP).
- The /pay page (`GET /store/:ws/orders/:orderId/payment`) for such an order: `paymentMethod: "bank_transfer"`, `status: "awaiting_payment"`, `canRetry` and `canSwitchToCod` false, `methods: []`; retry and switch-to-cod answer 409 `ORDER_IS_MANUAL`.

### Screens
- **Dashboard → Settings → Payments → «إنستا باي والمحافظ» / "InstaPay & wallets"** (only with `workspace.manage`): a list in order (drag or up/down → PUT order) with, per row, «إنستا باي» / "InstaPay" or «محفظة» / "Wallet", the name, the number, «فيه لينك دفع» / "Has a payment link", a switch «ظاهرة في الدفع» / "Shown at checkout" (`active`), «تعديل» / "Edit", «حذف» / "Delete" (confirm: «الطلبات اللي اتعملت بيها هتفضل محتفظة بالرقم» / "Orders placed with it keep its number"). «إضافة طريقة» / "Add a method" opens a form: «النوع» / "Type" (InstaPay / «محفظة (فودافون كاش، اتصالات كاش…)» / "Wallet (Vodafone Cash, Etisalat Cash…)"), «الاسم اللي يظهر للعميل» / "Name the shopper sees", «رقم المحفظة» / "Wallet number" or «حساب إنستا باي أو الرقم» / "InstaPay account or number", «لينك الدفع (اختياري)» / "Payment link (optional)", «تعليمات للعميل (اختياري)» / "Instructions for the shopper (optional)". Errors: «اكتب رقم محفظة صحيح» / "Enter a valid wallet number"; «اكتب حساب إنستا باي أو رقم صحيح» / "Enter a valid InstaPay account or number"; «اللينك لازم يبدأ بـ https://» / "The link must start with https://"; `TOO_MANY_PAYMENT_METHODS` «وصلت لأقصى عدد طرق (50)» / "You've reached the most methods (50)". Empty: «مفيش أرقام دفع — ضيف رقم إنستا باي أو محفظة يدفع عليه العميل وبعدها يبعت صورة التحويل» / "No payment numbers yet — add an InstaPay or wallet number the shopper pays to and then sends a screenshot". A note that the `bank_transfer` fee or discount in Payment rules applies to these too.
- **Order page → a card «الدفع بإنستا باي / محفظة» / "Paid by InstaPay / wallet"** when `manualPayment` is set: the method and number, the status badge «مستني صورة التحويل» / "Waiting for the screenshot" (`awaiting_proof`) · «مستني المراجعة» / "Waiting for review" (`submitted`) · «اتقبل» / "Approved" · «اترفض» / "Rejected"; «حوّل من» / "Paid from" (`payerNumber`), «اتبعت» / "Sent" (`submittedAt`), the screenshot (`proofUrl`, click to enlarge). With `orders.manage` and `awaitingReview`: «قبول الدفع» / "Approve payment" (confirm: «هيتسجل الطلب مدفوع بالكامل {total}» / "The order will be marked paid in full {total}") and «رفض» / "Reject" with a required reason «سبب الرفض (هيظهر للعميل)» / "Reason (the shopper sees it)". Rejected: «سبب الرفض: {rejectionReason}» / "Reason: {rejectionReason}" and «العميل يقدر يبعت صورة تانية» / "The shopper can send another screenshot". Errors: `MANUAL_PAYMENT_NOT_SUBMITTED` «مفيش صورة تحويل مستنية المراجعة» / "There's no screenshot waiting for review" (reload); `ORDER_CANCELLED` «الطلب ده اتلغى» / "This order is cancelled".
- **Order page and the confirmation queue**: while `manualPayment.status` isn't `approved`, the confirm button shows «لازم تقبل الدفع الأول» / "Approve the payment first" (disabled, or show `MANUAL_PAYMENT_NOT_APPROVED` with that text); the queue row gets a badge «إنستا باي / محفظة — {status}» / "InstaPay / wallet — {status}" and the screenshot thumbnail.
- **Storefront checkout**: each `store_method` entry is a payment option «{name}» with «ادفع على {accountNumber}» / "Pay to {accountNumber}" and a copy button «نسخ» / "Copy", the instructions, and «افتح لينك الدفع» / "Open the payment link" when `paymentLink` is set; its `adjustment` as for other methods. Placing the order sends `paymentMethod: "bank_transfer"` and `manualPaymentMethodId`, then goes to the proof page.
- **Storefront proof page** (the thank-you step for this order, and the /pay link of such an order: when GET `/payment` shows `paymentMethod: "bank_transfer"`, try GET `/manual-payment` with the same token and show this page on 200): «حوّل {totalAmount} على {label}» / "Send {totalAmount} via {label}", the number with «نسخ» / "Copy", the link, the instructions; then «الرقم أو حساب إنستا باي اللي حوّلت منه» / "The number or InstaPay account you paid from", «صورة التحويل (سكرين شوت)» / "Transfer screenshot", «ابعت إثبات الدفع» / "Send payment proof". Submitted: «وصلنا إثبات الدفع — المتجر هيراجعه ويأكد طلبك» / "We received your payment proof — the store will check it and confirm your order". Approved: «الدفع اتأكد» / "Payment confirmed". Rejected: «المتجر رفض إثبات الدفع: {rejectionReason}» / "The store rejected the payment proof: {rejectionReason}" and the form again. Cancelled (`canSubmit` false, not approved): «الطلب ده اتلغى» / "This order is cancelled". Errors: payerNumber «اكتب الرقم أو حساب إنستا باي اللي حوّلت منه» / "Enter the number or InstaPay account you paid from"; `NO_FILE` «ارفع صورة التحويل» / "Attach the transfer screenshot"; `UNSUPPORTED_MEDIA_TYPE` / `IMAGE_UNREADABLE` «الصورة لازم تكون JPEG أو PNG أو WebP» / "The screenshot must be JPEG, PNG or WebP"; `FILE_TOO_LARGE` / `IMAGE_TOO_LARGE` «الصورة كبيرة — جرّب صورة أصغر» / "The screenshot is too large — try a smaller one"; `PROOF_ALREADY_SUBMITTED` «إثبات الدفع اتبعت خلاص» / "The payment proof was already sent" (reload the status); `RATE_LIMITED` «محاولات كتير — جرّب بعد دقيقة» / "Too many tries — try again in a minute"; 404 «اللينك ده مش صالح» / "This link isn't valid".

## 341. Custom domains: the verification TXT on `_zimos-verify`, deployment rules, certificate states and suspension — UI: pending

The domains screen (Dashboard → Settings → Domains, `domain.manage`) keeps everything it has (root domains with A / ALIAS records and their www, the primary domain, redirects, buying a domain). What changes: the verification TXT record now goes on its own name, `_zimos-verify.<domain>`, so it never sits beside the CNAME; another store's unverified claim to a domain no longer blocks its owner; the certificate is asked for right after verification and followed by the server (no need to press "Check" any more, though the button stays); a certificate can be `moved`; a domain can be suspended. Each deployment rule is a server setting (names only in `.env.example`), and the overview says which apply so the screen can adapt: `CUSTOM_DOMAINS_ENABLED` (unset = on; anything but `true` closes the whole section), `CUSTOM_DOMAINS_SUBDOMAINS_ONLY` (`true` = no root domains, no buying), `CUSTOM_DOMAIN_CNAME_TARGET` (one host every domain points at; unset = the store's own `<slug>.<platform domain>`), `CUSTOM_DOMAINS_MAX_PER_STORE`, `CUSTOM_DOMAINS_PENDING_TTL_DAYS`, `DOMAIN_VERIFY_RESOLVERS`, `CERTIFICATE_PROVIDER` (`sandbox` | `cloudflare`), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`. Today (all unset) the screen behaves as before, with the TXT on its new name.

Domains added before this change: the dashboard now shows them the TXT on `_zimos-verify.<domain>`, but a TXT already added on the domain itself (the old place) still verifies them — the merchant need not move it.

### Endpoints (dashboard, all `domain.manage`, under `/workspaces/:workspaceId/domains`)
- **Closed** (`CUSTOM_DOMAINS_ENABLED` set to anything but `true`): every path below answers 404 `ROUTE_NOT_FOUND` with a token (401 without one), exactly like a path that does not exist. Hide Settings → Domains and the setup-guide step when GET `/domains/overview` answers 404. Domains already verified keep working on the storefront.
- **GET `/overview`** → 200, new fields marked:
  ```json
  {
    "domains": [{
      "id": "73deb867-…", "hostname": "ahmedstore.com", "status": "pending_verification", "verifiedAt": null, "isPrimary": false,
      "sslStatus": "none", "sslProvider": null, "sslCheckedAt": null,
      "sslDetail": null,
      "suspended": false, "suspendedReason": null,
      "verifyBy": null,
      "homeFunnel": null, "redirectToPrimary": true, "isRoot": true,
      "records": [
        { "type": "TXT", "name": "_zimos-verify.ahmedstore.com", "value": "zimos-verify=9e7a0e0e…", "ttl": 300, "purpose": "verification" },
        { "type": "ALIAS", "name": "ahmedstore.com", "value": "demo-store.zimos.co", "ttl": 300, "purpose": "routing" },
        { "type": "CNAME", "name": "www.ahmedstore.com", "value": "demo-store.zimos.co", "ttl": 300, "purpose": "redirect" }
      ],
      "alternatives": [],
      "counterpart": { "hostname": "www.ahmedstore.com", "redirect": true, "sslStatus": "none", "dnsManaged": false, "records": […], "alternatives": [] }
    }],
    "cnameTarget": "demo-store.zimos.co",
    "subdomainsOnly": false,
    "maxPerStore": null,
    "pendingTtlDays": null,
    "certificateProvider": "sandbox"
  }
  ```
  - `records[0].name` is now `_zimos-verify.<hostname>` (was the hostname). Show the name column as is; many DNS panels want only `_zimos-verify` (or `_zimos-verify.www`) in the "Name/Host" field — show that short form beside it ("Host: `_zimos-verify`").
  - `cnameTarget`: with `CUSTOM_DOMAIN_CNAME_TARGET` set it is that one host (e.g. `customers.zimos.co`) for every store and every routing record uses it.
  - `sslStatus`: `none` | `pending` | `issued` | `failed` | **`moved`** (the certificate was issued but the domain no longer points at the store). `sslDetail`: the provider's reason as a sentence (show as is under the status), or null.
  - `suspended` / `suspendedReason`: `store_suspended` (the store is suspended by the platform) or `plan` (the plan no longer includes custom domains while plan features are enforced). Set and cleared by the server within 10 minutes.
  - `verifyBy`: for a `pending_verification` domain when `pendingTtlDays` is set, the time after which it can no longer be verified (and is removed); null otherwise.
  - `subdomainsOnly: true`: no root domains (adding one answers `APEX_NOT_SUPPORTED`), no buying (search / purchase answer `APEX_NOT_SUPPORTED`), `counterpart` is null. `maxPerStore`: the most domains one store may hold (verified or not), null = only the plan's limit. `pendingTtlDays`: null = an unverified domain waits for ever.
- **GET `/`** (the short list): each item adds `"routing": [ { "type", "name", "value", "ttl", "purpose" } ]` (the records that point it at the store: a subdomain's CNAME, a root's A records or ALIAS, as in the overview) and `"cname": { "type": "CNAME", "name": "<hostname>", "value": "<cnameTarget>" }`, which is null for a root domain (a root cannot take a CNAME; show `routing`); `record.name` is `_zimos-verify.<hostname>`.
- **POST `/`** `{ "hostname": "www.ahmedstore.com" }` → 201 `{ "domain": {…}, "record": { "type": "TXT", "name": "_zimos-verify.www.ahmedstore.com", "value": "zimos-verify=…" }, "next": "…" }`. The hostname is stored lower-case; an Arabic name in its `xn--` form (show `hostname` as the browser would, or as is). Errors:
  - 422 `VALIDATION_ERROR` field `hostname`: "Enter a valid domain like www.ahmedstore.com", or "That is a zimos.co subdomain — it already works, no setup needed".
  - 400 `DOMAIN_NOT_ALLOWED`: an IP address, or a name that can never be a store's (the platform's hosting zones, `.local`, `.internal`, `.test`, `.example`, `.localhost` …).
  - 400 `APEX_NOT_SUPPORTED` (subdomains-only): `details.suggestion` = `"www.ahmedstore.com"`.
  - 409 `DOMAIN_ALREADY_ADDED` (already on this store), `DOMAIN_TAKEN` (verified by another store — an unverified claim elsewhere no longer counts), `DOMAIN_LIMIT_REACHED` (`maxPerStore`), `STORE_NOT_SET_UP`; 403 `PLAN_FEATURE_REQUIRED` / plan limit as before; 429 `RATE_LIMITED` (10 a minute per IP).
- **POST `/:domainId/verify`** → 200 as before. The TXT is looked for on `_zimos-verify.<hostname>`, then on the hostname itself (older domains). On success the certificate is requested at once: reload the overview (`sslStatus` usually `pending`). Errors: 400 `DOMAIN_NOT_VERIFIED` (message names `_zimos-verify.<hostname>`); 409 `DOMAIN_TAKEN` (another store verified it first); 409 `DOMAIN_VERIFICATION_EXPIRED` (past `verifyBy`: remove it and add it again); 429 `RATE_LIMITED` (20 a minute per IP).
- **GET `/:domainId/dns-check`** → `dns.txt` adds `"name": "_zimos-verify.<hostname>"` and `"foundOnHost": true|false` (`found` is true when either place has it); 429 `RATE_LIMITED` (30 a minute per IP).
- **POST `/:domainId/ssl/check`**: the answer's `domain` carries `sslDetail`; `sslStatus` may be `moved`.
- **PATCH `/:domainId`** `{ "redirectCounterpart": true }` → 400 `APEX_NOT_SUPPORTED` in subdomains-only mode.
- **GET `/search`**, **POST `/purchases`** → 400 `APEX_NOT_SUPPORTED` in subdomains-only mode. A purchase now checks `DOMAIN_LIMIT_REACHED` / `DOMAIN_ALREADY_ADDED` / `DOMAIN_TAKEN` before anything is bought, and a name another store only claimed (unverified) shows as available.

### Storefront proxy and console
- **GET `/store/resolve-host?host=…`**: a domain suspended for its `plan` answers 404 (treat it as an unknown host, as for any unknown domain). A domain of a suspended store answers as before, so the storefront shows the store's "unavailable" page there. A suspended or `moved` domain is never the `primaryHost`.
- **POST `/admin/workspaces/:workspaceId/support-view`** (console, `support.view`): each `domains[]` row adds `sslDetail` and `suspendedReason`.

### Screens (dashboard → Settings → Domains)
- **Add a domain**: the field hint follows `subdomainsOnly`: false «اكتب الدومين، مثلًا ahmedstore.com أو shop.ahmedstore.com» / "Type the domain, e.g. ahmedstore.com or shop.ahmedstore.com"; true «اكتب دومين فرعي، مثلًا www.ahmedstore.com أو shop.ahmedstore.com» / "Type a subdomain, e.g. www.ahmedstore.com or shop.ahmedstore.com". When `maxPerStore` is reached, disable the button with «وصلت لأقصى عدد دومينات ({maxPerStore}) — امسح واحد الأول» / "You've reached the most domains ({maxPerStore}) — remove one first".
- **DNS records card**: for the TXT row label it «إثبات الملكية» / "Ownership proof" and show «الاسم: _zimos-verify» / "Name: _zimos-verify" (or `_zimos-verify.www` for www) with a copy button «نسخ» / "Copy", and the full name in small text. Note under it: «لو كنت ضفت سجل TXT على الدومين نفسه قبل كده، هيشتغل برضه» / "If you already added the TXT on the domain itself before, it still works". With `verifyBy`: «لازم تأكد الدومين قبل {verifyBy} وإلا هيتمسح» / "Verify the domain before {verifyBy} or it will be removed".
- **Certificate badge** (`sslStatus`): «مفيش شهادة لسه» / "No certificate yet" (`none`) · «الشهادة بتتجهز» / "Certificate in progress" (`pending`, with «بنتابعها تلقائي — مش لازم تعمل حاجة» / "We follow it automatically — nothing to do") · «الشهادة شغالة» / "Certificate active" (`issued`) · «الشهادة فشلت» / "Certificate failed" (`failed`) · «الدومين مبقاش متوجه للمتجر» / "The domain no longer points at the store" (`moved`, with «راجع سجلات الـ DNS وبعدين اضغط افحص تاني» / "Check the DNS records, then press Check again"). Under `failed` / `moved` show `sslDetail` as is.
- **Suspended**: a warning on the row — `store_suspended` «الدومين متوقف لأن المتجر موقوف» / "This domain is paused because the store is suspended"; `plan` «الدومين متوقف — باقتك مش فيها دومين خاص» / "This domain is paused — your plan doesn't include a custom domain" with «رقّي الباقة» / "Upgrade plan" (→ Subscription). It comes back by itself once the reason is gone.
- **Errors**: `DOMAIN_NOT_ALLOWED` «الدومين ده مينفعش يتوصل بمتجر» / "This domain can't be connected to a store"; `APEX_NOT_SUPPORTED` «وصّل دومين فرعي زي {suggestion}، وحوّل الدومين الأساسي له من عند شركة الدومين» / "Connect a subdomain such as {suggestion}, and forward the main domain to it at your domain registrar" (button «استخدم {suggestion}» / "Use {suggestion}" fills the field); `DOMAIN_ALREADY_ADDED` «الدومين ده متضاف للمتجر خلاص» / "This domain is already on your store"; `DOMAIN_TAKEN` «الدومين ده متوصل بمتجر تاني» / "This domain is connected to another store"; `DOMAIN_LIMIT_REACHED` as above; `DOMAIN_VERIFICATION_EXPIRED` «عدّت المدة ومتأكدش — امسحه وضيفه تاني» / "It wasn't verified in time — remove it and add it again"; `RATE_LIMITED` «محاولات كتير — جرّب بعد دقيقة» / "Too many tries — try again in a minute".
- **Buy a domain** tab: hidden when `subdomainsOnly` is true (the API answers `APEX_NOT_SUPPORTED`).
- **Console → a store → support view → Domains**: show `suspendedReason` («موقوف: المتجر موقوف» / "Paused: store suspended", «موقوف: الباقة» / "Paused: plan") and `sslDetail` beside the certificate state.

## 346. Team: nobody gives, changes or removes access above their own — UI: pending

A teammate with `users.manage` / `roles.manage` (the Admin, or a custom role) can no longer make themselves Owner, invite an Owner, demote or remove an Owner, or create a role with permissions they do not hold. Only an Owner (`*`) works with Owner access. Nothing new to call; the existing calls can now answer one new error.

### Endpoints (all `/api/v1/workspaces/:workspaceId`, Bearer, unchanged permissions)
- **POST `/members`** `{ "email", "roleId" }` (users.manage), **POST `/team/invite`** `{ "access": "admin" | "partial", … }` (users.manage): 403 `ROLE_ABOVE_YOURS` when the role holds Owner access or a permission the caller lacks (a non-admin teammate inviting with `access: "admin"` gets it too).
- **PATCH `/members/:membershipId`** `{ "roleId" }` (users.manage): 403 `ROLE_ABOVE_YOURS` when the teammate's current role or the new one is beyond the caller's (so an Owner row cannot be changed by a non-Owner).
- **DELETE `/members/:membershipId`** (users.manage): 403 `ROLE_ABOVE_YOURS` when the teammate's role is beyond the caller's.
- **POST `/roles`** `{ "name", "key", "permissions": [...] }` (roles.manage): 403 `ROLE_ABOVE_YOURS` naming the permissions the caller lacks.
- Error body: `{ "error": { "code": "ROLE_ABOVE_YOURS", "message": "Only an Owner can give, change or remove Owner access" } }` or `{ "error": { "code": "ROLE_ABOVE_YOURS", "message": "You cannot give or change access you do not have: billing.manage", "details": [ { "field": "permissions", "message": "Not held by you: billing.manage" } ] } }`.

### Screens (dashboard → Settings → Team)
- **Members list**: for a caller who is not an Owner, hide or disable "Change role" and "Remove" on rows whose role is Owner (`role.key === "owner"`), with the tooltip «بس المالك يقدر يغيّر صلاحيات المالك» / "Only an Owner can change an Owner's access". In the role picker, leave the Owner role out unless the caller is an Owner.
- **Create role / partial invite**: untick and disable permissions the caller does not hold (`GET /team/access-options` already lists them; compare with the caller's own role).
- **Error `ROLE_ABOVE_YOURS`**: toast «مينفعش تدّي أو تغيّر صلاحيات أعلى من صلاحياتك» / "You can't give or change access above your own"; for the Owner case «بس المالك يقدر يدّي أو يغيّر أو يشيل صلاحيات المالك» / "Only an Owner can give, change or remove Owner access".

## 347. Google sign-in: verified email only, two-step sign-in, and the OAuth state — UI: pending

Google sign-in still starts with a full-page visit to `GET /api/v1/auth/google` and comes back to the dashboard's `/auth/callback` page. Nothing new to call; the callback page gets new query values.

### What changed in the flow
- `GET /auth/google` now sets a short httpOnly cookie (`zimos_gstate`, 10 minutes) and sends a `state` to Google. The sign-in must start and finish in the same browser: always open `/auth/google` with a full-page navigation (no `fetch`, no new browser), as today.
- An account with two-step sign-in on (authenticator app, email code or WhatsApp code) is no longer signed in straight away by Google. The callback redirects to:
  `/auth/callback?twoFactorRequired=true&challengeToken=<uuid>&channel=totp` (or `channel=email&sentTo=m***@company.com`, `channel=whatsapp|sms&sentTo=+20•••••5678`, and `codeNotSent=true` when too many codes went out — a backup code still works).
  Show the same "Enter your code" step as after a password sign-in and finish with the existing **POST `/api/v1/auth/two-factor/verify`** (no auth; same permission as today) `{ "challengeToken": "<uuid>", "code": "123456", "rememberDevice": true }` → 200 `{ "user": {…}, "accessToken": "…", "refreshToken": "…" }` (refresh token in the cookie in cookie mode, as usual); 401 `INVALID_TWO_FACTOR_CODE`, 429 `TOO_MANY_ATTEMPTS`.
- Without two-step sign-in nothing changes: `?status=ok` (cookie mode) or `?accessToken=…&refreshToken=…`.

### New `error` values on `/auth/callback`
| `error` | When | Arabic | English |
|---|---|---|---|
| `GOOGLE_EMAIL_UNVERIFIED` | The Google account's email is not verified by Google (only for a first sign-in with that Google account) | «إيميل حساب جوجل ده مش متأكد. أكّده عند جوجل أو ادخل بالإيميل وكلمة السر» | "This Google account's email isn't verified. Verify it with Google, or sign in with your email and password" |
| `GOOGLE_STATE_MISMATCH` | The sign-in was not started from this browser, or took over 10 minutes | «انتهت محاولة الدخول بجوجل. جرّب تاني» | "The Google sign-in expired. Please try again" |
| `GOOGLE_LOGIN_FAILED` | Google refused the sign-in code (used twice, expired) | «الدخول بجوجل منجحش. جرّب تاني» | "Google sign-in didn't work. Please try again" |

Each error screen shows a «جرّب تاني» / "Try again" button that opens `/api/v1/auth/google` again, and a link back to the sign-in page. `ACCOUNT_SUSPENDED` / `ACCOUNT_DELETED` are unchanged.
