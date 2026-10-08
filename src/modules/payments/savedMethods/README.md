# Saved payment methods — the tokenization contract

SPEC §11.6. A gateway that can save a card gives ZIMOS an opaque **token** for
it; the token is stored per customer in `payment_methods_saved` and can be
charged again without the shopper typing anything. It is what a one-click
upsell and a subscription renewal are built on. ZIMOS never sees or stores a
card number — only the gateway's token (sealed with `core/utils/secretBox.js`),
the brand, the last four digits and the expiry.

Implemented by `sandbox`, `stripe`, `paymob` and `paypal` (item 380, see
"The real gateways" below). `kashier` says `supportsTokenization: false`.

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

  // Charges a saved card. `reference` is our order id; `idempotencyKey` is
  // "<order>-<saved method>-<amount>" and is the gateway's duplicate-request key,
  // so a repeat (a timeout, a second click) gets the first answer back instead
  // of a second charge. After a definite 'failed' / 'needs_shopper' the caller
  // moves it on ("…-1", "…-2"), so a later retry reaches the bank again. A definite answer only: throw GatewayError when the
  // outcome is unknown. 'needs_shopper': the bank wants the shopper (3-D
  // Secure, PayPal's payer action) — nothing was taken.
  async chargeSaved(creds, { token, amount, currency, reference, idempotencyKey, contact, settings })
      -> { status: 'paid' | 'failed' | 'needs_shopper', transactionId?, failureReason?, failureCode? },

  // Optional (item 380):
  savedCardsReady(settings) -> boolean,  // false: this account cannot charge saved
                                         // cards (no card is saved, plan products refused)
  savedMethod: 'paypal',                 // the order payment method a charge is (default 'card')
  parseCardToken({ query, body, headers }, creds)   // a token the gateway POSTs on its own
      -> null | { valid, providerOrderId, card: { token, brand?, last4?, expiresAt? } },
};
```

`createPayment` also receives `saveCard` (consentedSave.wantsSave: the shopper
ticked "save my card", or the order holds a subscription or installment
product), for a gateway that must be told before the payment (Stripe, PayPal).

A token sent by `parseCardToken` (Paymob's TOKEN callback) is held sealed in
`gateway_card_tokens` (migration 516, `./heldCardTokens.js`) against the payment
of the same gateway order; `saveFromPayment` uses it before asking
`tokenize` and deletes it once saved. A token that arrives after the order was
paid is saved at once when the shopper agreed, and given to the order's
subscriptions that started without a card. Held tokens nobody saved are
dropped after 30 days. No token is ever logged or returned.

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
`SAVED_METHOD_NEEDS_SHOPPER` (422, the bank wants the shopper — item 380),
`ORDER_ALREADY_PAID` (409).

## Using it from other modules

`savedMethodService.listForCustomer(workspaceId, customerId)` and
`chargeOrder(workspaceId, savedId, orderId, req)` are the two calls an upsell
(SPEC §9.5) or a renewal (§18) needs. When the customer has no saved method —
or the gateway does not support tokenization — the upsell opens its normal
payment page instead. A charge that is declined or needs the shopper leaves the
follow-on order unpaid (it expires), and the upsell answers
`payment: { status: 'declined', code }` with `code` `SAVED_METHOD_DECLINED` or
`SAVED_METHOD_NEEDS_SHOPPER`; a renewal counts it as a failed attempt.

## The sandbox

`../gateways/sandbox.js` issues a token signed with the account's
`signingSecret` for any paid sandbox payment ("Sandbox •••• 4242", expiring in
two years) and approves every charge of a token it signed. No money moves.

## The real gateways (item 380)

| | Stripe | Paymob | PayPal | Kashier |
|---|---|---|---|---|
| Saved with a payment | Checkout Session with `customer_creation=always` and `payment_intent_data[setup_future_usage]=off_session` when `saveCard` | the shopper ticks "save card" on Unified Checkout (card saving switched on by Paymob for the card integration); the TOKEN callback | `payment_source.paypal.attributes.vault` `{ store_in_vault: ON_SUCCESS, usage_type: MERCHANT }` when `saveCard` and the `vault` setting | not offered |
| Token | `cus_…\|pm_…` | Paymob's card token | the vault id (`VAULTED` only) | — |
| Charged | `POST /v1/payment_intents` `confirm=true off_session=true`, `Idempotency-Key: zimos-saved-<key>` | intention on the MOTO integration (`special_reference = zimos-<key>`) → `payment_keys[0].key` → `POST /api/acceptance/payments/pay` `{ source: { identifier, subtype: TOKEN } }`; a repeat first asks `transaction_inquiry` by that reference | `POST /v2/checkout/orders` with `payment_source.paypal.vault_id`, `PayPal-Request-Id: zimos-saved-<key>` | — |
| Needs the shopper | 402 `authentication_required`, or `requires_action` | a pending transaction with a 3-D Secure redirect | `PAYER_ACTION_REQUIRED` | — |
| Ready when | always | the `motoIntegrationId` setting is filled | the `vault` setting is on | — |
| Card setup without a payment | Checkout Session `mode=setup` for a new Customer; the way back carries `session_id`, read from Stripe | no | no (PayPal is not a card for subscriptions) | no |

Kashier documents card tokens only on its Direct API (the merchant's own card
form), and the string a token payment is signed with could not be read from its
documentation, so it does not save cards; see `../gateways/kashier.js`.

Go-live checklist, per gateway sandbox, before a merchant relies on it:

- **Stripe** (test keys): pay with "save my card" ticked using 4242 4242 4242 4242, save, charge an upsell; 4000 0000 0000 0341 saves but declines later charges; 4000 0027 6000 3184 answers `authentication_required` off session; repeat a charge (same order, card, amount) and see one PaymentIntent.
- **Paymob** (test keys): ask Paymob for card saving on the card integration and a MOTO integration; check the TOKEN callback reaches the webhook URL and its HMAC verifies (field order in `paymob.js`); charge on the MOTO integration; confirm `special_reference` is unique and `transaction_inquiry` finds it by `merchant_order_id`; confirm the shape of the `/payments/pay` answer (plain transaction or `{ obj }`).
- **PayPal** (sandbox app): turn on Vault, tick the `vault` setting, pay with "save" ticked, check `GET /v2/checkout/orders/:id` shows the vault `VAULTED`; charge with the vault id; try the sandbox's negative testing for a decline and payer action.
