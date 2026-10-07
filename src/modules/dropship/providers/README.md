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
| `PATCH /providers/:code/settings` | `{ autoForward: "off" \| "created" \| "confirmed", applyStatus }` — forward orders by themselves, apply the supplier's status to the order |

On the order (`orders.view` / `orders.manage`, under `/workspaces/:workspaceId/orders/:orderId`,
`../dropshipOrders.js`): `GET /dropship` (what was forwarded, where it stands,
which connected suppliers supply its lines), `POST /dropship/:code/push`,
`POST /dropship/refresh` (ask the supplier now). A mixed order sends each
supplier only the lines whose product came from it.

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

  // Optional. Where a forwarded order stands now; with it, forwarded orders
  // are followed every few minutes until delivered / returned / cancelled.
  // `ref.pushedAt` is when it was forwarded. → { externalStatus }
  async getOrderStatus(credentials, externalOrderId, ref) {},

  // The provider's order status → a ZIMOS order stage, or null for "no change".
  mapStatus(externalStatus) {},

  // Optional (item 263). The supplier's shipping price for its lines to a
  // destination; with it the merchant can switch on "use the supplier's
  // shipping rates". lines: [{ code (variant code), quantity }].
  // → { amount (minor units), currency }
  async shippingQuote(credentials, { country, province, city, lines }) {},

  // Optional (item 263). The smallest order the supplier accepts, counted on
  // its own lines; with it the merchant can switch on "refuse orders below the
  // supplier's minimum". → { amount (minor units), currency } or null
  async minimumOrder(credentials) {},
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
fixed stock. Its orders move on with time (confirmed after 1 minute, shipped
after 3, delivered after 6; an order number ending in 0 comes back cancelled).
It is registered only when `NODE_ENV` is not `production` and
appears in the dashboard as "Test".

## The merchant's own store: `shopify.js`, `woocommerce.js` (item 181)

Not suppliers but the merchant's other store: ZIMOS takes the order, the
other store fulfils it, and its fulfilment comes back through the same
follow job (`dropship.follow_orders`). Both are registered in production too
and share `storeHttp.js` (https only — plain http only to 127.0.0.1/localhost
outside production, for a mock store — a 15 s timeout, no redirects, and the
error codes above).

| | Shopify | WooCommerce |
|---|---|---|
| Credentials | `storeUrl`, `accessToken` (custom app, Admin API: read/write orders, read products) | `storeUrl`, `consumerKey`, `consumerSecret` (REST API key, read/write) |
| Import code | the Shopify product id | the Woo product id |
| Variant SKU after import | the Shopify variant id | `<productId>` or `<productId>:<variationId>` |
| A line that maps to nothing | sent as a custom line (title, price, SKU) | refused, 409 `DROPSHIP_ORDER_REJECTED` |
| Pushing twice | finds the order by `source_identifier = zimos-<orderId>` | finds the order by meta `_zimos_order_id` |
| Status → stage | fulfilled → shipped, delivered → delivered, cancelled → cancelled | completed → shipped, cancelled/failed → cancelled, refunded → returned |

Shopify also returns the last fulfilment's tracking (`tracking`) from
`getOrderStatus`. There is no sandbox mode for these two: the `sandbox`
provider plays that part, and a mock store on localhost works outside
production.
