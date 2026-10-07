# Microsoft Advertising (UET) Conversions API (microsoftCapi.js)

Spec-gaps item 255. Server-side copies of the UET tag's events.

- **Pixel id**: the UET tag id (digits).
- **Token**: the CAPI access token made for that UET tag in Microsoft Advertising
  (Tools → UET tag → Conversions API).
- **Request**: `POST https://capi.uet.microsoft.com/v1/{tag_id}/events`,
  `Authorization: Bearer {token}`, body `{ data: [...] }` (see the file header).
- **Dedup**: `eventId` is the browser tag's event id (the order id for purchases). `msclkid`
  is the click id the ad link added.
- **Events**: purchase / submit_lead_form for orders, plus pageLoad, view_item, add_to_cart,
  begin_checkout, add_payment_info relayed from the storefront. `adStorageConsent` is `G`: events
  are only relayed for shoppers the store's cookie-consent rule allows.
- **Mode**: `MICROSOFT_CAPI_MODE=sandbox` (default) or `live`; `MICROSOFT_CAPI_BASE` overrides the host.
