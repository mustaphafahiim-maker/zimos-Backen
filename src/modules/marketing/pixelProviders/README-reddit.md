# Reddit Conversions API (redditCapi.js)

Spec-gaps item 255. Server-side copies of the Reddit Pixel's events, so a
conversion blocked in the browser still reaches Reddit.

- **Pixel id**: the Reddit ad account id the pixel belongs to (`a2_…` or `t2_…`).
- **Token**: a Conversions API access token, from Reddit Ads → Events Manager → Conversions API.
- **Test**: setting the pixel's "test event code" (any text) sends `test_mode: true`.
- **Request**: `POST https://ads-api.reddit.com/api/v2.0/conversions/events/{account_id}`,
  `Authorization: Bearer {token}`, body `{ test_mode, events: [...] }` (see the file header).
- **Dedup**: `event_metadata.conversion_id` is the browser tag's event id (the order id for
  purchases), so Reddit counts browser + server once. `click_id` is the `rdt_cid` the ad link added.
- **Events**: Purchase / Lead for orders (store or funnel "report leads"), plus PageVisit,
  ViewContent, AddToCart relayed from the storefront.
- **Mode**: `REDDIT_CAPI_MODE=sandbox` (default) builds, checks and logs the body without
  calling Reddit. Set `live` only after checking a real account. `REDDIT_API_BASE` overrides the host.
