# AI module — provider contract

`aiService` turns a merchant's request into a prompt, hands it to **one
provider**, validates the answer and stores it as a job. Choosing the real
provider and its key is the integrations team's work; this file is the
contract a provider must meet. `providers/sandbox.js` is the reference
implementation.

## Where a provider lives

`src/modules/ai/providers/<name>.js`, registered in `providers/index.js`.
`AI_PROVIDER=<name>` selects it. Empty means `sandbox` outside production
and no provider in production; `AI_PROVIDER=sandbox` set on purpose runs the
sandbox in production too, with a warning in the log. Nothing is asked while
`AI_ENABLED` is not exactly `true`, and `AI_DAILY_LIMIT` (default 50) caps
one store's requests per UTC day.
Its API key is read from the environment by the provider itself and is never
returned by any endpoint.

## Interface

```js
module.exports = {
  name: 'acme',                 // stored on ai_jobs.provider and ai_usage.provider
  isSandbox: () => false,       // optional; true shows a "Test" badge in the dashboard
  async generate(request) { return { output, usage }; },
};
```

### `request`

| Field | Type | Meaning |
| --- | --- | --- |
| `feature` | `'product' \| 'page' \| 'translate' \| 'policies' \| 'page_review' \| 'ad_creatives' \| 'store_builder' \| 'wa_reply'` | Which feature (see `features.js`; the last four in `featuresP2.js`). |
| `prompt` | string | The rendered prompt from `prompts/<file>.vN.md`, placeholders filled. Send this to the model. |
| `promptVersion` | string | e.g. `product_content.v1`. |
| `input` | object | The merchant's validated input (`features.js` → `input`). |
| `images` | string[] | Public http(s) URLs of the product photos the merchant attached (`product` only, at most 6; `[]` otherwise). Send them to a vision-capable model with the prompt; the prompt says how many there are. |
| `context` | object | Server-side facts the prompt was built from. `page`: `{ product: { id, name, slug, description, imageUrl, features[], faqs[] }, allowedElements[] }`. `page_review`: `{ pageKind, pageName, metrics, facts, outline }` (facts measured from the tree, `pageFacts.js`). `ad_creatives`: `{ product: { name, description, price, compareAtPrice, specialOfferText, features[], images[] } }`. `store_builder`: `{ themes[], allowedElements[] }`. `wa_reply`: `{ storeName, dialect, facts, products, orders, history, lastMessage, brain }`. Others: `{}`. |
| `workspaceId`, `jobId` | uuid | For the provider's own logging. No customer data is ever in a request. |

### Return value

- `output` — a plain object matching the feature's `output` schema in
  `features.js`. For `page`, `output.tree` must also pass
  `pages/pageTree.validatePageTree` (structured elements only — no HTML).
  Anything else fails the job with `AI_OUTPUT_INVALID`; nothing unvalidated is
  stored.
- `usage` — `{ tokensIn, tokensOut, costMicros, costCurrency }`. `costMicros`
  is the provider's own charge in millionths of `costCurrency`; `0`/`null`
  when unknown. Written to `ai_usage`.

### Errors

Throw an `Error`. Set `err.permanent = true` when a retry cannot help (bad
key, content refused, unknown feature); otherwise the `ai` queue retries once
after 30 seconds. `err.message` (first 500 characters) is shown to the
merchant on the failed job, so it must not contain secrets.

## What the module guarantees around a provider

- **Draft only.** Output is stored on the job. "Apply" creates a *draft*
  product or an *unpublished* page; the merchant publishes. `store_builder`
  applies as an unpublished page plus *hidden* collections — the theme and
  policies it suggests are switched on by the merchant. `ad_creatives`
  banners must sit on the product's own images (others are dropped), and
  `store_builder`'s `home.tree` must pass `validatePageTree`. `wa_reply` only
  fills the inbox's message box; a person sends it.
- **Limits.** A request is refused before the provider is called when the
  store is over its plan's `ai_requests_per_month` (read from the plan's
  features; absent = no monthly limit) or over the abuse guard of 30 requests
  per hour.
- **No fake content.** The prompts forbid invented reviews, counters, stock
  and urgency (SPEC §21); a provider must not add them.

## `support_reply` — the WhatsApp customer service bot

Called synchronously by `whatsapp/bot/botBrain.js` for each customer message
the bot answers (no job row). Unlike the merchant features, the request does
carry conversation text: the customer's new message (`input.message`), the
last few messages in `prompt`, and in `context` the store's facts, its active
products with price and stock, and **this customer's own** latest orders
(number, status, total — never an address or another customer's data).
`input.dialect` is the merchant's chosen tone.

Answer `{ action: 'reply' | 'handoff', text }`. `handoff` hands the
conversation to the team (the bot stays quiet there until someone lets it
answer again). The sandbox answers with fixed rules (`providers/sandboxSupport.js`).
