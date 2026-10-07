# Team channels: alerts in Telegram, Slack and Discord (spec-gaps item 378)

A store sends its alerts (new order, suspicious order, low stock, a failing
integration, a disputed payment…) to a team channel: a Telegram group, a
Slack channel or a Discord channel shared with its team, media buyer or
fulfilment partner. A channel is not a ZIMOS seat; it is a row in
`team_channels` with the notification types it asked for.

`../teamChannelService.js` holds the channels (credentials sealed with
`core/utils/secretBox`, never returned), picks which channels get a
notification (`merchantNotificationService.create` hands it every store-wide
notification), writes the message and keeps each channel's health. An adapter
only sends one text.

## Contract

```js
module.exports = {
  code: 'telegram',          // telegram | slack | discord | sandbox
  sandbox: false,
  maxLength: 4096,           // the text is cut to this
  async send(credentials, text, provider) // resolves on success; throws Error(message) otherwise
};
```

`credentials` is `{ botToken, chatId }` for Telegram and `{ webhookUrl }` for
Slack and Discord. The error message is kept as the channel's `lastError` and
shown on its card, so it must never contain the token or the URL. An error with
`permanent: true` means retrying will not help (wrong token, removed webhook).

## Adapters

- `telegram.js` — Bot API `POST /bot<token>/sendMessage` `{ chat_id, text }`,
  plain text (no `parse_mode`). `TELEGRAM_API_BASE` changes the host (default
  `https://api.telegram.org`).
- `slack.js` — incoming webhook `POST { text }`; `& < >` escaped so text
  typed by a shopper cannot mention `<!channel>`.
- `discord.js` — channel webhook `POST { content, allowed_mentions: { parse: [] } }`,
  so `@everyone` pings nobody.
- `sandbox.js` — nothing leaves the server; the message is logged. A chat id
  or webhook URL ending in `sandbox-fail` fails. Never used in production.

All three live adapters post through `webhooks/webhookSender.js`: the
connect-time private-address check, no redirects, and a deadline on the whole
exchange (8 s at most). Slack and Discord URLs are also checked when saved
(their own host only, and `webhookUrlGuard.checkUrl`).

`TEAM_CHANNELS_PROVIDER`: `live` or `sandbox`. Default `live` in production,
`sandbox` elsewhere.

## Merchant setup

- Telegram: talk to @BotFather → `/newbot` → copy the token. Add the bot to the
  group. The group id (like `-1001234567890`) is shown by @RawDataBot or
  `getUpdates`; a public channel can use `@name` (the bot must be an admin).
- Slack: api.slack.com/apps → Create app → Incoming Webhooks → Add to a channel
  → copy the URL.
- Discord: Channel settings → Integrations → Webhooks → New webhook → Copy URL.

## Behaviour

- A notification with a dedupe key reaches a channel at most once
  (`team_channel_deliveries` partial unique index).
- Ten failures in a row pause the channel (`is_active = false`) and send an
  `integration.failed` alert to the store's managers; switching it back on or
  entering new credentials starts the count over.
- Types meant for one teammate (`export.ready`, `shipping.batch_done`,
  `customer.followup`, `announcement`) are never sent to a channel.
- The automation step `notify_channel` sends its text to one channel.
- Delivery rows are pruned after 30 days.
