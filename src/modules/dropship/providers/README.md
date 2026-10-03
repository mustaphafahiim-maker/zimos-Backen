# Dropshipping providers — the contract

A **provider** is a dropshipping company the merchant sells for (Taager,
Anjezni, AliExpress…): products are imported from it, orders are forwarded to
it, and its stock is the stock. Each provider is one file in this folder,
registered in `index.js`. Writing a real provider is the integrations team's
work; this file and `sandbox.js` are what they build against.

## Where a connection lives

`workspace_integrations`, one row per (workspace, provider), `provider =
"dropship:<code>"`. The credentials object is sealed in `secrets_sealed`
(`core/utils/secretBox.js`) and never returned by any endpoint; `config` holds
the non-secret account name.

Imported products carry `externalRefs: [{ platform: "<code>", code: "<externalId>" }]`
and each variant's `sku` is the provider's variant code. A pushed order is a
row in `dropship_order_refs`.

Endpoints (permission `apps.manage`, under `/workspaces/:workspaceId/dropship`):

| | |
|---|---|
| `GET /providers` | providers, whether each is connected, the planned ones |
| `PUT /providers/:code` | connect: `{ credentials }` (verified first) |
| `DELETE /providers/:code` | disconnect |
| `POST /providers/:code/import` | `{ code }` → a draft product |
| `POST /providers/:code/orders/:orderId/push` | forward an order |
| `POST /providers/:code/sync-stock` | copy the provider's stock onto imported variants |

## The adapter

```js
module.exports = {
  code: 'taager',                 // lower-case, unique
  name: 'Taager',
  isTest: false,
  credentialFields: [             // the connect form is rendered from this
    { key: 'apiKey', label: { en: 'API key', ar: 'مفتاح API' }, secret: true, required: true },
  ],

  // Throws if the credentials do not work. → { accountName }
  async verifyCredentials(credentials) {},

  // One product by the provider's own code.
  // → { externalId, name, description, images: [url], currency,
  //     variants: [{ code, options: { Color: 'Black' }, priceAmount, costAmount, stock }] }
  async importProduct(credentials, code) {},

  // Forward an order. `order` is the public API's order shape
  // (publicApi/publicOrderSerializer.js) with `items[].sku` = the variant code.
  // Must be safe to call twice for the same order.
  // → { externalOrderId, externalStatus }
  async pushOrder(credentials, order) {},

  // Current stock for the given product ids.
  // → [{ externalId, code, stock }]
  async syncStock(credentials, externalIds) {},

  // The provider's order status → a ZIMOS order stage, or null for "no change".
  mapStatus(externalStatus) {},
};
```

Amounts are integers in minor units (piasters). `priceAmount` is the suggested
selling price, `costAmount` what the provider charges the merchant.

## Errors

Throw an `Error` with:

| `code` | `status` | when |
|---|---|---|
| `DROPSHIP_INVALID_CREDENTIALS` | 422 | the provider refused the credentials |
| `DROPSHIP_PRODUCT_NOT_FOUND` | 404 | no product with that code |
| `DROPSHIP_ORDER_REJECTED` | 409 | the provider will not take the order (below its minimum, out of stock…); put its reason in `message` |
| `DROPSHIP_UNAVAILABLE` | 502 | network error, timeout, or a 5xx from the provider |

Anything else is reported as `DROPSHIP_UNAVAILABLE`. Never put credentials in a
message.

## The sandbox

`sandbox.js` answers without any network: products `SBX-1001` (two colours)
and `SBX-1002`, order numbers `SBX-ORD-######` derived from the order number,
fixed stock. It is registered only when `NODE_ENV` is not `production` and
appears in the dashboard as "Test".
