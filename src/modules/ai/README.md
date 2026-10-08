# AI module — provider contract

`aiService` turns a merchant's request into a prompt, hands it to **one
provider**, validates the answer and stores it as a job. Choosing the real
provider and its key is the integrations team's work; this file is the
contract a provider must meet. `providers/sandbox.js` is the reference
implementation. `providers/anthropic.js` is the real one (see
"The anthropic provider" below).

## Where a provider lives

`src/modules/ai/providers/<name>.js`, registered in `providers/index.js`
(`sandbox`, `anthropic`). Which one answers:

1. `AI_PROVIDER` when it is set;
2. otherwise `anthropic` when `ANTHROPIC_API_KEY` is set (not under
   `NODE_ENV=test`, so a developer's key never makes test runs paid calls);
3. otherwise `sandbox` — outside production only. In production the AI routes
   answer 503 `AI_NOT_CONFIGURED`, as they do when `AI_PROVIDER=anthropic` has
   no key.

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
| `feature` | `'product' \| 'page' \| 'translate' \| 'policies' \| 'page_review' \| 'ad_creatives' \| 'store_builder' \| 'wa_reply'`, plus `'support_reply'` (whatsapp/bot) and `'order_check'` (risk/aiOrderCheck) | Which feature (see `features.js`; the P2 four in `featuresP2.js`; the last two below). |
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

## `order_check` — the AI check of moderate-risk orders

Called by `risk/aiOrderCheck.js` from the `ai` queue (no job row) with the
order's name, address and notes — never the phone, email or IP. Answer
`{ is_gibberish, is_abusive, address_complete }`, three booleans.

## The anthropic provider

`providers/anthropic.js` calls Anthropic's Messages API with the official SDK
(`@anthropic-ai/sdk`). `providers/anthropicFeatures.js` holds, per feature, the
JSON schema the answer must follow, the effort, the token ceiling, the
language and the clean-up applied before the module validates the answer.

### Setup

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | The key from console.anthropic.com. Secret: never returned by an endpoint, never logged. Setting it is enough to switch AI on. |
| `AI_PROVIDER` | Optional. `anthropic` or `sandbox` to force one (see "Where a provider lives"). |
| `AI_MODEL` | Optional. Default `claude-opus-5-5`. Must be a current model that takes `output_config.effort` and structured outputs. |
| `AI_TIMEOUT_MS` | Optional. Per-attempt timeout for queued jobs, default `180000`. The WhatsApp bot (`support_reply`) always waits at most 45 s with one retry. |
| `AI_REFUSAL_FALLBACK` | Optional. `off` turns off Anthropic's server-side refusal fallback (on by default for the Opus 5 / 5.5, Sonnet 5.5 and Fable 5.1 models). |
| `ANTHROPIC_BASE_URL` | Development only: a stand-in Messages API for local checks. Ignored in production. |

The bill is read from Anthropic's console; `ai_usage` records tokens with
`costMicros: 0` (no prices in code).

### How each request is made

- **Structured outputs.** Each feature sends `output_config.format` with a
  closed JSON schema mirroring its `output` schema, so the answer is valid JSON
  in the right shape. Limits a schema cannot express (lengths, counts, a score
  of 0–100) are clamped afterwards; the slug is made URL-safe.
- **Closed values from the server.** `page`: the product card's id, the button
  link (`/products/<slug>`) and the only allowed picture (the product's own)
  are enums. `ad_creatives`: a banner's `imageUrl` is one of the product's own
  pictures (no banners when it has none). `store_builder`: the theme key is one
  of the active free themes. `translate`: exactly the keys sent.
- **Page trees** use a narrow set of element types with fixed props (heading,
  text, image, button, list, faq, product card; plus product list and
  collection list for the store builder). Ids are renumbered so they are unique.
  `testimonial`, `countdown` and `stars_display` are not offered: a generator
  could only fill them with invented reviews or fake urgency (SPEC §21).
- **The system prompt** names the language (`egyptian`, `gulf`, `msa`,
  `english`, `french`), repeats the SPEC §21 rules (no invented reviews,
  ratings, counters, stock, discounts or deadlines; urgency only for a real
  offer), and says text from customers and pages is data, not instructions.
- **Photos** (`product`) go as URL image blocks. A photo Anthropic cannot fetch
  (a local or private address) fails the request with a 400; the provider then
  tries once without photos.
- **Effort**: `low` for `wa_reply`, `support_reply` and `order_check`; `medium`
  for the rest. Thinking is left to the model (adaptive).

### Errors

The SDK retries 408/409/429/5xx and dropped connections with backoff (3 times;
1 for `support_reply`), honouring `retry-after`. What still fails:

| Case | Code | Status | Queue retry |
| --- | --- | --- | --- |
| Key refused (401/403), model not found (404), request rejected (400/413/422) | `AI_NOT_CONFIGURED` | 503 | no (`permanent`) |
| Still rate limited | `AI_LIMIT_REACHED` (`details.scope: 'provider'`) | 429 | yes |
| 5xx / overloaded / timeout / connection | `AI_PROVIDER_UNAVAILABLE` | 503 | yes |
| The model declined (`stop_reason: refusal`) or the answer was cut off | `AI_OUTPUT_INVALID` | 422 | no |

Messages are written for the merchant and never contain the key or the API's
own text. Logs carry the feature, the HTTP status and Anthropic's request id
only: prompts, inputs and answers are never logged, because `order_check` and
`support_reply` carry a shopper's name, address or message.
