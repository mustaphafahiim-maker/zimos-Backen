# Payment gateway adapters — the contract

A **gateway** is an online payment company a merchant connects with their own
account (Paymob, Kashier). The money goes straight to the merchant's account;
ZIMOS never holds it. Each gateway is one file in this folder, registered in
`index.js`. Writing a new gateway from SPEC §11.2 is the integrations team's
work; this file and `sandbox.js` are what they build against.

`cod`, `mock` (in `../providers`) and `manual` (customer transfers with a
receipt, `../manualTransferService.js`) are **not** gateways.

## Where a connection lives

`payment_gateway_accounts`, one row per (workspace, gateway):

| column | value |
|---|---|
| `provider_code` | the adapter's `code` |
| `credentials_encrypted` | the credentials object, AES-256-GCM (`core/utils/credentialsCipher.js`, key `GATEWAY_CREDENTIALS_KEY`), never returned by any endpoint |
| `settings` | non-secret settings (integration ids, enabled sub-methods) |
| `mode` | `test` \| `live` — methods of a `test` account are shown only in the store preview |
| `webhook_token` | random token in the account's webhook URL |

Endpoints (all `workspace.manage`): `GET /payments/gateways`,
`PUT /payments/gateways/:code`, `DELETE /payments/gateways/:code`,
`GET|PUT /payments/methods`. The dashboard's connect form is rendered from the
adapter's descriptive fields — a new gateway needs no dashboard code.

## The adapter

```js
module.exports = {
  // --- descriptive ---
  code: 'paymob',                 // stable id, lower-case
  name: 'Paymob',
  methods: ['card', 'wallet'],    // which checkout methods it can take
  currencies: ['EGP'],
  credentialFields: [{ key, secret, label: { en, ar }, placeholder? }],
  settingFields:    [{ key, method?, type, label: { en, ar } }],
  setupSteps: { en: [...], ar: [...] },
  helpLinks:  [{ label: { en, ar }, url }],
  webhookSetup: { field, perIntegration, automatic? },
  webhookDuplicateStatus,         // optional, default 200
  credentialsSchema, settingsSchema,   // Joi

  // --- behaviour: decrypted credentials are always the first argument ---
  modeFromCredentials(creds) -> 'test' | 'live',
  availableMethods(settings) -> string[],
  async verifyCredentials(creds, settings) -> { mode, credentials?, settings? },
  async createPayment(creds, { attempt, order, method, settings, returnUrl,
                               webhookUrl, expiresInSeconds, storeName, locale })
      -> { providerOrderId, providerReference, redirectUrl },
  async inquire(creds, { payment }) -> { found: false } | { found: true, transaction, payload },
  async inquireTransaction(creds, { transactionId, payment }) -> transaction | null,
  async refund(creds, { payment, amount, settings })
      -> { status: 'processed'|'pending'|'failed', providerRefundReference, failureReason, failureCode? },
  parseWebhook({ query, body, headers, rawBody }, creds) -> null | { valid, eventKey, transaction, payload },  // may be async
  parseRedirect(query, creds)                   -> null | { valid, eventKey, transaction, payload },
};
```

### The normalized `transaction`

```js
{
  kind: 'payment' | 'refund' | 'void' | 'dispute',
  status,                 // payment: 'paid' | 'failed' | 'pending'; refund/void: 'processed' | 'failed' | 'pending'
  transactionId,          // the gateway's id for this transaction
  parentTransactionId,    // the payment a refund/void belongs to, or null
  providerOrderId,        // what createPayment returned; how a callback finds our attempt
  amount, currency,       // integer minor units
  maskedDisplay,          // "Visa •••• 4242" — never a full card number
  failureReason, failureCode?,
}
```

### Rules every adapter follows

- **Amounts** are integer minor units in and out. Never floats.
- **Never log credentials** or put them in an error message; pass gateway
  messages through `gatewayErrors.sanitizeGatewayMessage`.
- **Errors:** `GatewayAuthError` (the keys were refused), `GatewayRejectedError`
  (a definite refusal — safe to show and retry), `GatewayError` (no definite
  answer — the outcome is unknown and must be inquired, never assumed failed).
- **HTTP** goes through `gatewayHttp.request` (timeouts, no redirects, no
  secrets in logs).
- **Callbacks:** `parseWebhook` / `parseRedirect` never throw. They return
  `null` for a callback we do not act on and `valid: false` when the signature
  does not match. `eventKey` must be the same for the webhook and the redirect
  of one transaction in one state, so the two are recorded once.
- **Idempotency:** `createPayment` is called once per attempt; `inquire` and
  `refund` may be repeated and must return the same answer.
- **Test mode** must be detectable from the credentials (`modeFromCredentials`)
  or recorded by `verifyCredentials`.

Optional, not called by the core yet (SPEC §11.1 / §11.6): `describe()`,
`validateCredentials(config)`. Saved cards — `supportsTokenization`, `tokenize`,
`chargeSaved`, and optionally `createCardSetup` / `completeCardSetup`,
`savedCardsReady`, `savedMethod`, `parseCardToken` — are specified in
`../savedMethods/README.md`; see "Saved cards on the real gateways" below.

## The `sandbox` adapter

`sandbox.js` implements all of the above with no network. `createPayment`
returns a link to a page this API serves (`../sandboxPayRoutes.js`,
`/api/v1/sandbox-pay/:providerOrderId`) with **Approve** and **Decline**; the
choice comes back on the redirect, signed with the account's `signingSecret`,
and is read by `parseRedirect` — the same path a real gateway takes. It is
always `test` mode (visible only in the store preview) and is registered only
when `NODE_ENV !== 'production'` or `PAYMENTS_SANDBOX_GATEWAY=true`.

## Adding a gateway

1. Copy the shape of `sandbox.js`, implement the functions against the
   gateway's API through `gatewayHttp.request`.
2. Register it in `index.js`.
3. Add its environment variables (base URL only — keys belong to the merchant)
   to `config/env.js` and `.env.example`.
4. Connect it in test mode from Payments in the dashboard, pay from the store
   preview, refund from the order page.

## Stripe and PayPal (`stripe.js`, `paypal.js`, spec-gaps item 183)

Both follow the contract above; neither has a signed redirect, so the way
back asks the gateway (`inquire`) and the payments sweep settles anything left.

| | Stripe | PayPal |
|---|---|---|
| Method | `card` (Checkout page: card, Apple Pay, Google Pay, Link) | `paypal` (new method, migration 460) |
| Credentials | `secretKey` (sk_test_/sk_live_ → mode), optional `webhookSecret` (whsec_) | `clientId`, `clientSecret`; live or sandbox found by signing in, kept as `environment` |
| Currencies | USD EUR GBP EGP SAR AED MAD QAR CAD AUD TRY | USD EUR GBP CAD AUD |
| Payment | Checkout Session, Idempotency-Key = attempt | Orders v2 CAPTURE, PayPal-Request-Id = attempt |
| Paid when | session `payment_status = paid` | `inquire` captures an APPROVED order (once) |
| Webhook | `checkout.session.*`, refunds (`charge.refunded`, `charge.refund.updated`, `refund.*`) and `charge.dispute.*`; Stripe-Signature over the raw body (5 min tolerance); ignored without a signing secret | `PAYMENT.CAPTURE.REFUNDED` and `CUSTOMER.DISPUTE.*` only; the refund or dispute is fetched from PayPal by its id with the merchant's keys (the body is never believed) |
| Refund | `/v1/refunds` on the payment intent | `/v2/payments/captures/:id/refund` |

`expressFor(method, settings)` (optional): `{ wallets: [...] }` marks a method
as express buttons; the storefront methods list carries it as `express`.
Stripe's card has `apple_pay`, `google_pay` unless the setting
`expressWallets` is false; PayPal has `paypal`; the sandbox offers both so
they can be tried in the store preview.

`STRIPE_API_BASE` / `PAYPAL_API_BASE` (ignored in production) point them at a
mock; `gatewayHttp.request` takes `form` for form-encoded bodies.

### Optional: `inquireRefund(credentials, { refundReference, payment })`

A refund's outcome by the gateway's own refund id (what `refund` returned as `providerRefundReference`):
`{ status: 'processed' | 'failed' | 'pending', transactionId, failureReason }`, or null when the gateway doesn't
know it. The pending-refund sweep uses it when present (Stripe, PayPal); otherwise it asks `inquireTransaction`
with the refund's reference. `refund` also receives `refundId` (our Refund row): use it as the gateway's
duplicate-request key, so two refunds of the same amount stay two.

### Optional: `cancelPayment(credentials, { payment })` and `refetchTransaction(credentials, payload)`

- `cancelPayment`: an attempt cancelled or expired on our side stops taking payment at the gateway (Stripe
  expires the Checkout Session). Called after the change commits, best effort; refusals for an already
  closed page are ignored.
- `refetchTransaction`: for a gateway whose stored event payload keeps only ids, the sweep asks the
  gateway again and gets the normalized transaction (same shape as `parseWebhook`'s `transaction`).
  Used when the adapter has no `normalizeTransaction`.


### Refunds made in the gateway and disputes (item 377)

- **Refunds**: a refund webhook returns the normalized `transaction` with `kind: 'refund'` and
  `parentTransactionId` = the id stored as `Payment.providerTransactionId` (Stripe: the payment intent; PayPal:
  the capture). `gatewayRefundService.recordRefundTransaction` settles our own refund or records one made in the
  gateway's dashboard (source `gateway`), never more than what is left of the payment.
- **Disputes**: `kind: 'dispute'`, with `transactionId` = the gateway's dispute id, `parentTransactionId` as
  above, `status` one of `inquiry | needs_response | under_review | won | lost | closed`, `providerStatus`,
  `amount`, `currency`, `reason`, `evidenceDueBy`, `openedAt`. `../disputeService.js` keeps one
  `payment_disputes` row per dispute (migration 511), flags the order (`payment_disputed`, then
  `chargeback_lost` when lost — a courier is not booked while either is set), writes a `chargeback` refund for a
  lost one, an audit row on the order and a `payment.disputed` notification. `eventKey` includes the status, so
  each move is processed once.
- An adapter that confirms a webhook by asking the gateway (PayPal) may make `parseWebhook` async. When the
  gateway cannot be asked, it returns `{ valid: true, transaction: null, payload }`: the event is stored
  unprocessed and the sweep calls `refetchTransaction(creds, payload)` for it.
- Sandbox: the `sandbox` gateway does not report disputes; try them with Stripe test keys
  (card 4000 0000 0000 0259) and a webhook endpoint, or PayPal's sandbox dispute simulator.

### Saved cards on the real gateways (item 380)

One-click upsells and subscription renewals charge a saved card through `chargeSaved`
(`../savedMethods/README.md` has the contract and the go-live checklist):

- **Stripe** — the card is kept when the shopper agreed (`createPayment` gets `saveCard`: Checkout with
  `customer_creation=always` + `setup_future_usage=off_session`); the token is `cus_…|pm_…`; charged with an
  off-session confirmed PaymentIntent and `Idempotency-Key`; `authentication_required` is `needs_shopper`.
  Card setup without a payment: Checkout in `setup` mode.
- **Paymob** — the token comes on the TOKEN callback to the same webhook URL (`parseCardToken`, HMAC-SHA512 over
  card_subtype, created_at, email, id, masked_pan, merchant_id, order_id, token) and is held sealed until saved;
  charged on the MOTO integration (new optional setting `motoIntegrationId`; without it nothing is saved and
  subscription products are refused at checkout). No idempotency header: the intention's `special_reference`
  is the key and a repeat asks `transaction_inquiry` first. A pending 3-D Secure answer is `needs_shopper`.
- **PayPal** — Vault (new setting `vault`, off by default: the app must have Vault on, or PayPal would refuse
  the payment). The vault id is the token; charged with `vault_id` and `PayPal-Request-Id`;
  `PAYER_ACTION_REQUIRED` is `needs_shopper`. A charge is an order payment method `paypal`.
- **Kashier** — `supportsTokenization: false`: its card tokens belong to the Direct API (our page would collect
  the card), and the signed string for a token payment could not be grounded in its documentation.

Check against stand-ins: `STRIPE_API_BASE`, `PAYPAL_API_BASE` and `PAYMOB_BASE_URL` (outside production).
