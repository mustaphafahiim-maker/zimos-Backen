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
