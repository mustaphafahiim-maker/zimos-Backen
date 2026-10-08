# Push providers

Push notifications to the merchant's devices (SPEC §20): the dashboard PWA
(web push) now, the mobile app (Expo → FCM/APNs) later. Devices register in
`device_tokens` (`/api/v1/me/push/devices`); merchant notifications with the
`push` channel on are sent to every device of the person (pushService.js).

Shoppers get push only for what they asked for themselves (SPEC §21: no
campaigns): updates on their order from the thank-you page (orderPush.js,
`order_push_subscriptions`) and one "back in stock" message for a sold-out
variant (stockAlertPush.js, `stock_alerts` channel `push`, the subscription
dropped once sent). Both need the store's app on (its service worker shows
the push); `GET /store/:ws/push-config` says whether push is available and
gives the VAPID public key.

## Contract

A provider module exports:

| Export | Purpose |
| --- | --- |
| `name` | Stored on each notification log row. |
| `publicKey()` | The VAPID public key the browser subscribes with, or `null` (no web push). |
| `problem()` | Optional: why the provider cannot work (missing or bad keys), or `null`. `index.js` then has no provider. |
| `checkToken(platform, token)` | Optional: throws 422 `INVALID_PUSH_SUBSCRIPTION` when a token cannot be used; the registration routes call it. |
| `send(device, message)` | Delivers one push. `device` = `{ id, platform, token }` (`token` is the browser's subscription JSON for `web`). `message` = `{ title, body, link, type, workspaceId, orderId?, ttl?, urgency? }`. Resolves `{ status: 'sent' }`; throws an error with `gone = true` when the device no longer exists (HTTP 404/410 from the push service) — the device is then removed. |

## Providers

- `sandbox` (default outside production when no VAPID keys are set): records each push in
  `notification_logs` and sends nothing.
- `webpush` (webpush.js): the Web Push protocol through the `web-push` package.
  Chosen when `WEB_PUSH_PUBLIC_KEY` and `WEB_PUSH_PRIVATE_KEY` are set (or
  `PUSH_PROVIDER=webpush`); `WEB_PUSH_SUBJECT` is a `mailto:` address or an
  `https:` URL the push services can contact. Generate the pair once per
  environment with `node scripts/generate-vapid-keys.js` (a new pair voids
  every existing browser subscription). Keys are checked at start-up (sizes,
  the private key matching the public one, the subject); a problem is logged
  once and push stays off.
  - VAPID (RFC 8292): `Authorization: vapid t=<ES256 JWT>, k=<public key>`,
    `aud` = the push service's origin, `exp` = 12 hours, `sub` = the subject.
  - Payload `{ title, body, link, type }` encrypted per RFC 8291 (`aes128gcm`);
    a body too long for the 4 KB record (3993 bytes of JSON) is cut with "…".
  - `TTL` 24 h (12 h for "out for delivery"), `Urgency` normal (high for new
    and suspicious orders and "out for delivery"); one order's updates share a
    `Topic`, so a newer one replaces an undelivered older one.
  - 404/410 → `gone`: the device (or order/stock-alert subscription) is
    removed. 429, 5xx and network errors are retried here (3 attempts, ~1.5 s
    then ~5 s; the callers catch per device, so a queue retry would resend to
    the rest); anything else fails and is logged. Each push is a
    `notification_logs` row (provider `webpush`, recipient `web:<id>`, never
    the endpoint).
  - The endpoint must be on a browser push service (FCM, Mozilla, Windows,
    Apple) so nobody can make the server POST elsewhere;
    `WEB_PUSH_EXTRA_HOSTS` (comma-separated hostnames) adds a self-hosted
    service or a local stand-in for testing.
  - The private key is read from the env only, never logged or returned.
  The dashboard's service worker (`public/sw.js`) and the store's show
  `{ title, body, link }` and open `link` on tap.
- `expo` (to add, with the mobile app): Expo push tokens (`platform` ios/android).

Register a provider in `index.js` and set `PUSH_PROVIDER`. Unset: `webpush`
when its keys are set, else `sandbox` outside production; production never
falls back to the sandbox (only `PUSH_PROVIDER=sandbox` on purpose), so
without keys it sends nothing and logs "No push provider" once.
