# Pinterest Conversions API — adapter contract

`pinterestCapi.js` sends a store's order conversion (and, through
`browserEvents.js`, page visits, add-to-cart and leads) to Pinterest from the
server, beside the Pinterest Tag in the browser. It reverses item 154's
"browser only" decision at the owner's request (spec-gaps item 168).

## What the merchant gives

On a `pinterest` tracking pixel (`/workspaces/:ws/tracking-pixels`):

| Field | Where | Notes |
|---|---|---|
| Tag id | `pixelId` | the Pinterest Tag, 10–16 digits (unchanged) |
| Ad account id | `config.adAccountId` | digits; required to turn the Conversions API on |
| Conversion access token | `capiToken` | sealed with `secretBox`, never returned |
| Test events | `testEventCode` (any value = on) | sends with `?test=true` |

## The call

```
POST {PINTEREST_API_BASE|https://api.pinterest.com/v5}/ad_accounts/{adAccountId}/events[?test=true]
Authorization: Bearer {token}
{ "data": [{ "event_name": "checkout" | "lead" | "add_to_cart" | "page_visit",
             "action_source": "web", "event_time": 1760000000, "event_id": "<order id>",
             "event_source_url": "https://…",
             "user_data": { "em": ["sha256"], "ph": ["sha256"], "client_ip_address": "…",
                            "client_user_agent": "…", "external_id": ["sha256"] },
             "custom_data": { "currency": "EGP", "value": "450", "order_id": "…",
                              "content_ids": ["…"], "contents": [{ "id": "…", "quantity": 1, "item_price": "450" }],
                              "num_items": 1 } }] }
```

- Email, phone and external ids are lower-cased, trimmed and SHA-256 hashed before they leave the server.
- `event_id` is the order id, the same id the browser tag uses, so Pinterest counts one conversion.
- `value` and prices are strings in major units, as Pinterest documents them.
- Errors: 401/403 → `PINTEREST_CAPI_AUTH_FAILED`; other non-2xx → `PINTEREST_CAPI_ERROR`;
  network → `PINTEREST_CAPI_UNREACHABLE`; missing account/token → `PINTEREST_NOT_CONFIGURED`.

## Modes

| `PINTEREST_CAPI_MODE` | Behaviour |
|---|---|
| unset / `sandbox` (default) | builds and checks the body, logs it, answers `{ sandbox: true, num_events_received }`; nothing leaves the server |
| `live` | sends it to Pinterest |

The default is the sandbox until the owner has checked a real ad account and token against it.
`PINTEREST_API_BASE` points the live mode at another host (a proxy or a mock).

## Not done here

- No OAuth app: the merchant pastes a conversion token from Pinterest Ads Manager.
- No catalog or audience sync.
