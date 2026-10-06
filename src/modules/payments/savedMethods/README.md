# Saved payment methods — the tokenization contract

SPEC §11.6. A gateway that can save a card gives ZIMOS an opaque **token** for
it; the token is stored per customer in `payment_methods_saved` and can be
charged again without the shopper typing anything. It is what a one-click
upsell and a subscription renewal are built on. ZIMOS never sees or stores a
card number — only the gateway's token (sealed with `core/utils/secretBox.js`),
the brand, the last four digits and the expiry.

Only the `sandbox` gateway implements it. Adding it to a real gateway is the
integrations team's work; this is what they implement.

## What a gateway adds to its adapter

On top of the adapter in `../gateways/README.md`:

```js
module.exports = {
  // ...
  supportsTokenization: true,

  // The token for the card behind a PAID payment. The shopper's consent is
  // the gateway's own flow (its hosted page offers "save this card"); this
  // only asks for the token that consent produced. Returns null when the
  // shopper did not agree.
  async tokenize(creds, { payment, customerId, settings })
      -> null | { token, brand?, last4?, expiresAt? },

  // Charges a saved card. `reference` is our order id (idempotency key on the
  // gateway's side). A definite answer only: throw GatewayError when the
  // outcome is unknown.
  async chargeSaved(creds, { token, amount, currency, reference, settings })
      -> { status: 'paid' | 'failed', transactionId?, failureReason? },
};
```

## Saving a card without a payment (optional)

A subscription's card update from the customer's portal and a free trial with
nothing to pay now (SPEC §18.1) need a card saved with no charge. A gateway
that can do it adds both functions; without them the portal says the store
cannot take a new card yet, and a trial must have something to pay (shipping).

```js
module.exports = {
  // ...
  // Where to send the customer to give a card. `reference` is ours (unique);
  // the gateway sends the customer back to `returnUrl` with its answer in the
  // query string, signed like a payment redirect.
  async createCardSetup(creds, { workspaceId, reference, returnUrl, webhookUrl, settings })
      -> { redirectUrl },

  // The answer that came back: the saved card's token, or null when the
  // customer cancelled or the query is not a valid answer for `reference`.
  async completeCardSetup(creds, { workspaceId, reference, query, settings })
      -> null | { token, brand?, last4?, expiresAt? },
};
```

`cardSetup.js` calls them and stores the card like any other (its
`source_payment_id` is null, or the trial's payment of 0). The sandbox's page
is `/api/v1/sandbox-pay/setup/:workspaceId/:reference`, with Save card and
Cancel (`../gateways/sandboxCardSetup.js`, `../sandboxSetupRoutes.js`).

Codes: `CARD_SETUP_NOT_SUPPORTED` (422), `CARD_SETUP_FAILED` (424),
`CARD_NOT_SAVED` (422).

## Storage

`payment_methods_saved`: `workspace_id`, `customer_id`, `provider_code`,
`token_sealed`, `brand`, `last4`, `expires_at`, `source_payment_id`,
`last_used_at`. The token is never returned by any endpoint.

## Endpoints (`/workspaces/:id/saved-payment-methods`)

| | | permission |
|---|---|---|
| `GET /customers/:customerId` | the customer's saved cards | orders.view |
| `GET /orders/:orderId` | saved cards of the order's customer, the order's payments that can still be saved, what the order still owes | orders.view |
| `POST /` `{ paymentId }` | save the card behind a paid payment | orders.manage |
| `POST /:savedId/charge` `{ orderId }` | charge what the order still owes | orders.manage |
| `DELETE /:savedId` | forget the card | orders.manage |

Codes: `TOKENIZATION_NOT_SUPPORTED` (422), `PAYMENT_NOT_PAID` (409),
`TOKENIZATION_FAILED` (424), `SAVED_METHOD_EXPIRED` (409),
`SAVED_METHOD_MISMATCH` (422), `SAVED_METHOD_DECLINED` (422),
`ORDER_ALREADY_PAID` (409).

## Using it from other modules

`savedMethodService.listForCustomer(workspaceId, customerId)` and
`chargeOrder(workspaceId, savedId, orderId, req)` are the two calls an upsell
(SPEC §9.5) or a renewal (§18) needs. When the customer has no saved method —
or the gateway does not support tokenization — the upsell opens its normal
payment page instead.

## The sandbox

`../gateways/sandbox.js` issues a token signed with the account's
`signingSecret` for any paid sandbox payment ("Sandbox •••• 4242", expiring in
two years) and approves every charge of a token it signed. No money moves.
