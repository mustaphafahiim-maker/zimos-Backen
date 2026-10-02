# Fawaterak: paying the Zimos subscription online

Code: `src/modules/billing/onlineBillingService.js` and `src/modules/billing/fawaterak/`.
This is Zimos's own Fawaterak account, used only to collect subscription
charges (`billing_invoices`). It has nothing to do with the stores' payment
gateways in `src/modules/payments`.

## Sources (fetched 2026-10-01)

- https://app.fawaterk.com/documentation is the official API reference. It is
  a JavaScript page. Its machine-readable exports on the same site are what
  was used:
  - `https://app.fawaterk.com/documentation/api/openapi.json` (OpenAPI 3.1,
    `info.version` 3.0.0, Last-Modified 2026-09-06)
  - `https://app.fawaterk.com/documentation/llms-full.txt`
- No SDK, plugin or third-party write-up was used.

## How a payment works

1. The merchant presses Pay: `POST /api/v1/workspaces/:id/billing/payments`
   (`billing.manage`).
   - The charge is priced on the server (`createCharge`, which reuses an open one).
   - The price payable now is frozen on a `billing_payment_attempts` row.
   - `POST /api/v3/createTransaction` without `payment_method_id` gives a hosted
     checkout link for exactly that amount, in EGP.
2. The merchant pays on Fawaterak's page and is sent back to
   `{FRONTEND_URL}/settings?payment=<attemptId>`. The page reads
   `GET /api/v1/workspaces/:id/billing/payments/:attemptId`, which asks Fawaterak
   while the payment is in progress. The redirect itself proves nothing.
3. Fawaterak's webhook arrives. Its signature is checked, but **the paid
   webhook's signature covers only `TransactionId`, `TransactionKey` and
   `PaymentMethod`**: not the status, the amount or `pay_load`, and there is no
   timestamp. So a webhook only prompts a check, and the payment is believed
   only from `POST /api/v3/getTransactionData`, when all of these hold:
   - `paid === 1`;
   - `pay_load.attemptId` is the attempt;
   - `total` is exactly the frozen amount;
   - `currency` is `EGP`.
4. The charge is settled through `settlePaid`, the same path as a payment
   recorded by hand, at the frozen price.
   - A charge already paid is never paid again (the attempt becomes
     `paid_duplicate`: money to refund by hand).
   - A payment that doesn't match settles nothing (`mismatch`).
   - A failed, cancelled or expired attempt never touches the charge or the
     subscription.
5. `scripts/sweep-billing-payments.js` asks about attempts whose webhook
   never came, and processes webhooks that couldn't be acted on.

Refunds are handled by hand in Fawaterak. The refund webhook is only recorded:
an audit row, plus "refunds reported" on the charge in the console.

## Environment

| Variable | Value |
|---|---|
| `ONLINE_BILLING_ENABLED` | `true` lets merchants start a payment. Anything else: off. Webhooks and the sweep work whenever the keys are set. |
| `FAWATERAK_ENV` | `staging` (default) or `live`: `https://staging.fawaterk.com` / `https://app.fawaterk.com` |
| `FAWATERAK_BASE_URL` | optional override (https) |
| `FAWATERAK_TOKEN_URL` | optional. Default `{base}/oauth/token`; must be on the base URL's origin |
| `FAWATERAK_CLIENT_ID`, `FAWATERAK_CLIENT_SECRET` | Fawaterak dashboard → Integrations → OAuth client credentials |
| `FAWATERAK_HASH_KEY` | the dashboard's "HASH API key": the key webhooks are signed with ("your vendor API key" in the reference) |
| `FAWATERAK_WEBHOOK_TOKEN` | ours, at least 32 characters (`openssl rand -hex 32`) |

None of these are read under `NODE_ENV=test`: the tests use fake values and a
fake Fawaterak (`tests/helpers/fakeFawaterak.js`). The access token is kept in
memory only, for at most an hour, and is never logged.

## Setup in the Fawaterak dashboard (Integrations)

Webhook URLs, with `<token>` = `FAWATERAK_WEBHOOK_TOKEN`:

| Dashboard field | URL |
|---|---|
| Webhook (paid) | `{APP_URL}/api/v1/billing/fawaterak/<token>/paid_json`. Also sent with every transaction |
| Failed webhook | `{APP_URL}/api/v1/billing/fawaterak/<token>/failed_json` |
| Cancellation webhook | `{APP_URL}/api/v1/billing/fawaterak/<token>/cancel` |
| Refund webhook | `{APP_URL}/api/v1/billing/fawaterak/<token>/refund` |

Paid and failed end in `_json`, so Fawaterak sends JSON. Fawaterak's
commission must be on Zimos, not on the customer: the paid total has to equal
the charge exactly.

The cron service, every 5 minutes: `node scripts/sweep-billing-payments.js`.

## Before going live (staging only)

1. Set the staging keys with `FAWATERAK_ENV=staging`, and the four webhook
   URLs above in the staging dashboard.
2. Pay one charge with a test card: Mastercard `5123450000000008`, 12/26,
   CVV 100.
3. Check that the paid webhook was accepted (no `signature does not verify`
   warning in the log, and the attempt and charge are `paid`). That confirms:
   - the HASH API key is the key the reference calls the vendor API key;
   - the digest is hex.

   Neither is stated outright in the reference.
4. Check that `getTransactionData` returned `pay_load` and a `total` equal to
   the charge. Otherwise the attempt shows `mismatch`.
5. Try a failing card (Mastercard `5543474002249996`, 05/26, CVV 123). The
   attempt must become `failed`, and the subscription must not change.
6. Only then turn on `ONLINE_BILLING_ENABLED` on staging. Use the live keys
   only after that.

## Not documented by Fawaterak (handled conservatively)

- The webhook retry policy and source IPs. Hence the sweep and the path token.
- The time zone of `paid_at`. The charge is dated when Zimos confirmed the
  payment, and Fawaterak's text is kept in the audit row.
- How `data.expires_in` of a checkout relates to its `due_date`. The attempt
  expires at `expires_in`, and the sweep keeps asking for a day after.
- No way to cancel a checkout link. A payment on a superseded link still
  settles the charge if it is unpaid, and is otherwise caught as a duplicate.
