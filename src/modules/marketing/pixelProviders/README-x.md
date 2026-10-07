# X (Twitter) Conversions API (xCapi.js)

Spec-gaps item 255. Server-side copies of the X pixel's conversions.

- **Pixel id**: the X pixel id (the base tag id, e.g. `o1abc`).
- **Token**: X signs requests with OAuth 1.0a in the user context of an app that has access
  to the ad account, so the token is the four keys joined by colons:
  `consumerKey:consumerSecret:accessToken:accessTokenSecret`. They are sealed like every
  other token and never returned.
- **Event ids**: each conversion is one of the pixel's events made in X Ads Manager
  (`tw-<pixel>-<event>`), saved in the pixel's `config.eventIds` per standard event
  (`purchase`, `lead`, `add_to_cart`, …). An event without an id is not sent.
- **Request**: `POST https://ads-api.x.com/12/measurement/conversions/{pixel_id}`, OAuth 1.0a
  HMAC-SHA1 header, body `{ conversions: [...] }` (see the file header).
- **Identifiers**: X needs at least one: the `twclid` the ad link added, the hashed email or the
  hashed phone. Orders always have the phone; anonymous storefront events are sent only with a twclid.
- **Dedup**: `conversion_id` is the browser tag's id (the order id for purchases).
- **Mode**: `X_CAPI_MODE=sandbox` (default) builds and signs the request and logs it; `live` sends.
  `X_ADS_API_BASE` overrides the host (and API version).
