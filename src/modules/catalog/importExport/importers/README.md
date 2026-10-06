# Product importers — AliExpress, Etsy, CJ, YouCan

`POST /workspaces/:ws/catalog/products/import` with `{ "url": "<product link>" }` imports one product (as a draft)
and the reviews its page publishes. Shopify links keep their own path (`productTransfer.fromShopifyLink`).

## Interface

`importers/index.js`: `detect(url) → 'aliexpress' | 'etsy' | 'cj' | 'youcan' | null`, `fromLink(url) → { source, products: [transferProduct] }`.
A transfer product is productTransfer's import shape plus `reviews: [{ authorName, rating 1–5, comment, date }]`,
`sourceUrl`, `sourceCurrency`.

## Adapters

| Mode | What it does |
|---|---|
| default — structured data (`structuredData.js`) | Fetches the page (https only, public addresses only, no redirects, 3MB) and reads schema.org JSON-LD `Product` (also in `@graph`): name, description, pictures, price + currency, SKU, `review[]`; Open Graph as fallback for name/picture/price. Works for any page that publishes it (YouCan and Etsy product pages do; many AliExpress pages render client-side and may not). |
| `PRODUCT_IMPORT_MODE=sandbox` | Answers every supported link with a sample product named "(sandbox)", no price, **no reviews**. Nothing is fetched. |
| official APIs (to add) | AliExpress Dropshipping API (app key + secret), CJ API v2 (the merchant's CJ token — the dropship provider already holds it), Etsy Open API v3 (app key). Each maps to the same transfer shape; they need the owner's / merchant's credentials. |

## Rules

- Imported products are drafts with stock 0; the page's price is kept in minor units of the page's currency and noted in
  the description — the merchant checks price and currency before publishing.
- Reviews: only those the page itself publishes, saved with `source: 'import'`, `status: 'pending'` (approve in Reviews);
  never invented (SPEC §21), never shown before approval. At most 50 per product.
- A page that refuses, times out or has no product data → 422 `IMPORT_SOURCE_UNREACHABLE` with the reason.
