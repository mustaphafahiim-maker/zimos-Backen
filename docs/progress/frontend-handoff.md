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
