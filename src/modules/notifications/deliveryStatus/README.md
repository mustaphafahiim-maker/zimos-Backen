# Delivery status for customer emails and SMS

Off unless `DELIVERY_STATUS_ENABLED=true`: the webhooks and the suppression
list answer 404, no list is checked before an email and Twilio is asked for no
status callback.

Every email and SMS ZIMOS sends is a row in `notification_logs`. This module
fills in what happened after the provider took the message, and keeps the
email suppression list.

- `notification_logs.provider_message_id` — the provider's id for the message
  (Brevo `messageId` without the `<>`, Twilio `MessageSid`, `console-<uuid>`).
- `notification_logs.status` — `sent` / `failed` at send time (an enum, left as
  it was). `notification_logs.delivery_status` — then from the provider:
  `delivered`, `bounced`, `complained`, `undelivered`; `suppressed` (with
  status `failed`) when the email was not sent because the address is on the list.
  `status_at` / `status_reason` hold when and why.
- The status only moves up: `sent → delivered → undelivered | bounced →
  complained`. Duplicates and late or out-of-order events change nothing, and
  only the event that moved the status adds a suppression or a bell
  notification (`message.undelivered`, for messages about an order).
- `email_suppressions` — an address that hard-bounced (`hard_bounce`) or whose
  owner marked an email as spam (`complaint`). Checked by `notify.email` before
  every send, transactional emails too. Soft bounces and deferrals never
  suppress; they are noted in `status_reason`. Account and security emails
  (sign-in, sign-up and change-email codes, password reset, security notices,
  the shopper's sign-in code) are always sent — see `EXEMPT_TEMPLATES` in
  `suppressions.js`.
- Scope: a store's emails are suppressed per store, and the merchant sees and
  lifts them (`GET/DELETE /api/v1/workspaces/:ws/email-suppressions`).
  Emails sent without a store (platform account emails) use the platform scope.
- Separate from marketing opt-outs (`MarketingOptOut`): an opt-out stops
  marketing only; a suppression stops all email to the address.

## Brevo (email)

1. Pick a long random secret and set `BREVO_WEBHOOK_TOKEN` in the API's env.
2. In Brevo: *Transactional → Settings → Webhooks → Add a new webhook*
   (or `POST https://api.brevo.com/v3/webhooks` with `"type": "transactional"`).
   - URL: `https://<api host>/api/v1/webhooks/email/brevo`
   - Events: Delivered, Hard bounce, Soft bounce, Spam (complaint), Invalid
     email, Blocked, Error, Deferred. (Opens and clicks are ignored.)
   - Authentication, any one of:
     - Bearer token: `"auth": { "type": "bearer", "token": "<BREVO_WEBHOOK_TOKEN>" }`
     - Basic auth: any username, the token as the password
       (`https://user:<token>@<api host>/api/v1/webhooks/email/brevo`)
     - A custom header `X-Webhook-Token: <token>`
     - Last resort: `?token=<token>` in the URL (redacted from request logs).
3. Batched webhooks (`"batched": true`, an array of events) are accepted, up to
   1000 events a request.

Answers: 200 `{ ok, received, updated, unchanged, unknown, noted, ignored }`;
401 `INVALID_WEBHOOK_SIGNATURE` when the token is missing or wrong (nothing is
read or stored); 503 `WEBHOOK_NOT_CONFIGURED` when `BREVO_WEBHOOK_TOKEN` is
unset. An event for a message we don't know gets 200, so Brevo stops retrying.

Event mapping: `delivered` → delivered; `hard_bounce`, `invalid_email` →
bounced + suppression `hard_bounce`; `spam` (`complaint`) → complained +
suppression `complaint`; `blocked`, `error` → undelivered; `soft_bounce`,
`deferred` → noted only. The event's `email` must match the message's
recipient.

## Twilio (SMS)

1. Set `NOTIFICATIONS_WEBHOOK_BASE_URL` to the API's public origin
   (e.g. `https://api.zimos.com`). From then on every SMS is sent with
   `statusCallback = <base>/api/v1/webhooks/sms/twilio`. Unset, no callback is
   requested (Twilio can't reach a localhost URL).
2. `TWILIO_AUTH_TOKEN` (already used for sending) verifies the callbacks:
   `X-Twilio-Signature` = base64 HMAC-SHA1 with the auth token over the full
   URL Twilio called + the POST fields sorted by name (Twilio's
   `validateRequest`, constant-time, with and without the port). The URL is
   checked both as configured and as the request arrived, for proxies.
3. Nothing to set up in the Twilio console; a Messaging Service's own status
   callback URL can point to the same path.

Status mapping: `delivered` (and `read`) → delivered; `undelivered`, `failed` →
undelivered with `ErrorCode` in the reason; `queued`, `sending`, `sent`,
`accepted` change nothing. 401 on a bad signature, 503 without an auth token.

Both webhooks are rate-limited per provider (`DELIVERY_WEBHOOK_RATE_LIMIT_MAX`
a minute, default 3000), not per IP.

## Sandbox: the console provider

With `EMAIL_PROVIDER=console` / `SMS_PROVIDER=console`, sends get a
`console-<uuid>` message id. Outside production:

- The two webhooks also match console messages, so the signed path can be
  tried end to end with that id.
- `NOTIFICATION_STATUS_SIMULATION=true` makes the console report a status
  1.5 s after each send, through the same code as the webhooks:
  - email to `name+bounce@…` → hard bounce (suppressed), `+complaint` →
    complaint (suppressed), `+softbounce` → noted, `+blocked` → undelivered,
    anything else → delivered;
  - SMS to a number ending in `0000` → undelivered (error 30003), others →
    delivered.

## Another provider

Add a route that verifies the provider's own signature first, then maps each
event to `deliveryStatus.apply({ providers: [<provider name as logged>],
messageId, status, reason, at, recipient, suppress, source })` — or
`deliveryStatus.note(...)` for temporary failures — and store the provider's
message id when sending (`notify.js`).
