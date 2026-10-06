# Address autocomplete providers (spec-gaps item 184)

The checkout's address field asks `GET /store/:ws/address/suggest`, and a
pick asks `GET /store/:ws/address/details`. `index.js` picks the store's
provider (`workspace_integrations` row `address_autocomplete`, config
`{ provider: off | builtin | google }`, a key sealed with secretBox) and
matches every picked address back to the store's places list, so delivery
prices, hidden places and courier maps keep working.

## Contract

```js
module.exports = {
  code, name: { en, ar }, needsKey, attribution,   // attribution: 'google' → "Powered by Google"
  async verify?(credentials),                         // a new key is tried once before it is kept
  async suggest({ workspace, credentials, country, q, lang, session })
      // → [{ id, text, secondaryText, level: 'region'|'city'|'area'|'address' }], at most 8
  async details({ workspace, credentials, country, id, lang, session })
      // → { country, province, city, area, addressLine, postalCode, placeId, location: {lat,lng}|null } | null
};
```

Errors carry `code`: `ADDRESS_LOOKUP_INVALID_KEY` (422; kept as the setting's
`lastError`, and the shopper falls back to `builtin`) or
`ADDRESS_LOOKUP_UNAVAILABLE` (502; also falls back).

## Providers

- `builtin.js` — the store's places list, or the platform's governorates and
  cities when it has none. No network, no key: the default, and this
  interface's sandbox. Ids `p:<store place id>` / `g:<geo code>`.
  Arabic folding (`fold.js`): one alef, ya, ha, no diacritics.
- `google.js` — Places API (New) autocomplete + details with the store's own
  key; `session` groups a shopper's typing and pick into one billed session.
  `GOOGLE_PLACES_API_BASE` points at a mock outside production.
