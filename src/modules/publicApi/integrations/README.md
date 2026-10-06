# Zapier and Make (spec-gaps item 193)

Both connect to a store with an **API key** (Settings → Developers → API keys) and the public API
(`/api/public/v1`, `Authorization: Bearer <key>`). Nothing here holds Zapier's or Make's secrets.

## Connection

- Test call / connection label: `GET /me` → `{ workspaceId, apiKey: { name, scopes }, actingAs, store: { id, name, currency } }`.
  Label: `{{store.name}}`.
- Scopes the key needs: `webhooks:write` (triggers), plus the read/write scopes of the actions used
  (`orders:read`, `orders:create`, `customers:write`…).

## Triggers (REST hooks)

| Step | Call |
|---|---|
| Subscribe | `POST /webhooks` `{ "url": "<hook url from Zapier/Make>", "events": ["order.created"] }` → `{ endpoint: { id }, signingSecret }` |
| Unsubscribe | `DELETE /webhooks/<id>` |
| Sample data ("perform list") | `GET /webhooks/samples/<event>?limit=3` → the store's latest real payloads of that event, newest first (a marked sample when there are none yet) |
| Event names | `GET /webhooks/events` |

A delivery body is `{ id, type, createdAt, workspaceId, data }` — the same as the samples, so fields map 1:1.
Deliveries are signed (`X-Zimos-Signature`); Zapier and Make may ignore it. A store can hold 25 subscriptions.

Suggested triggers: New order (`order.created`), Order paid (`order.paid`), Order confirmed (`order.confirmed`),
Order shipped (`shipment.status_changed`), Order delivered (`order.fulfilled`), New lead (`lead.created`),
New customer (`customer.created`), Contact updated (`contact.updated`), Abandoned checkout (`checkout.abandoned`),
New review (`review.created`).

## Actions (existing public API)

Create order (`POST /orders`), Add order note, Update tracking, Find order (`GET /orders?q=`), Create/update
customer, Create discount — see `GET /api/public/v1/openapi.json`.

## Publishing the apps

Publishing a Zapier integration or a Make app is done in their developer consoles by the owner (accounts and review are
theirs); this file is the mapping to enter there.
