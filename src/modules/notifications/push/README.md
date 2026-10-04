# Push providers

Push notifications to the merchant's devices (SPEC §20): the dashboard PWA
(web push) now, the mobile app (Expo → FCM/APNs) later. Devices register in
`device_tokens` (`/api/v1/me/push/devices`); merchant notifications with the
`push` channel on are sent to every device of the person (pushService.js).

## Contract

A provider module exports:

| Export | Purpose |
| --- | --- |
| `name` | Stored on each notification log row. |
| `publicKey()` | The VAPID public key the browser subscribes with, or `null` (no web push). |
| `send(device, message)` | Delivers one push. `device` = `{ id, platform, token }` (`token` is the browser's subscription JSON for `web`). `message` = `{ title, body, link, type, workspaceId }`. Resolves `{ status: 'sent' }`; throws an error with `gone = true` when the device no longer exists (HTTP 404/410 from the push service) — the device is then removed. |

## Providers

- `sandbox` (default outside production): records each push in
  `notification_logs` and sends nothing.
- `webpush` (to add): the Web Push protocol with VAPID — `WEB_PUSH_PUBLIC_KEY`,
  `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` (mailto:). Generate the key pair
  once (`npx web-push generate-vapid-keys`) and use the `web-push` package's
  `sendNotification(JSON.parse(device.token), JSON.stringify(message), { TTL: 3600 })`.
  The dashboard's service worker (`public/sw.js`) shows `{ title, body, link }`.
- `expo` (to add, with the mobile app): Expo push tokens (`platform` ios/android).

Register a provider in `index.js` and set `PUSH_PROVIDER`.
