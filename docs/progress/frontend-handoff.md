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
