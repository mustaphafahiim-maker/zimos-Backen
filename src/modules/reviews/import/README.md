# Review importers

`POST /workspaces/:workspaceId/reviews/import` reads the reviews of one product
page in the merchant's own Shopify store and stores them as reviews of one
ZIMOS product (SPEC §7.7). `index.js` does the filtering (photos only, minimum
rating, language), de-duplication and storage; an importer only fetches.

## Contract

An importer is a module exporting:

| export | type | |
| --- | --- | --- |
| `name` | string | Shown to the merchant ("Sandbox", "Judge.me"…). |
| `sandbox` | boolean | True for test importers: the dashboard says so. |
| `fetchReviews({ url, limit })` | async → rows | The reviews of the product at `url`, at most `limit`. |

Each row:

| field | | |
| --- | --- | --- |
| `rating` | 1–5 | Required; a row without one is dropped. |
| `authorName` | string | As the source shows it; "Customer" when empty. |
| `comment` | string \| null | Plain text. |
| `photos` | string[] | Public `http(s)` image links, at most 6 kept. |
| `language` | string \| null | ISO 639-1 (`ar`, `en`…), for the language filter. |
| `externalId`, `createdAt` | | Optional; informative only. |

A link the importer can't read throws `AppError` 422 (`REVIEW_IMPORT_BAD_LINK`
or the importer's own code); a source that is down throws 502/503.

## Choosing the importer

`REVIEW_IMPORT_PROVIDER` (default `sandbox`). Register a new importer in
`REGISTRY` in `index.js`. The sandbox is refused in production
(503 `REVIEW_IMPORT_UNAVAILABLE`), so production needs a real importer before
the dashboard's "Import reviews" works there.

## Adding the real one

Shopify has no reviews of its own: stores keep them in a reviews app
(Judge.me, Loox, Yotpo…), each with its own API and the store's token. The
real importer is an open decision — which apps to support and how the
merchant hands over their token (an integration setting per store). Whatever
is chosen implements the contract above; nothing outside this folder changes.
Reviews must be the merchant's own, as they appear on their store — never
generated.

## Sandbox

`sandbox.js` answers any `https://<shop>/products/<handle>` link with the
same twelve reviews for that link: ratings spread over 1–5, Arabic and
English, every fourth with a placeholder photo. Each says it is a sandbox
review. Importing the same link twice imports nothing the second time.
