# How merchants pay Zimos: payment methods and transfer proofs

Merchants pay their subscription charges (`billing_invoices`) through the
methods in `payment_methods` (migration 130). There are two kinds:

- **manual**: a transfer (InstaPay, a mobile wallet) to the number on the
  row, then a proof with a screenshot that a platform admin checks.
- **gateway**: a hosted checkout through an adapter in
  `src/modules/billing/gateways/adapters/`. Fawaterak is the only one today
  ([billing-fawaterak.md](billing-fawaterak.md)).

The table never holds a secret: a gateway's keys live in the environment only.

## What a merchant is offered

`GET /api/v1/workspaces/:id/billing/payment-methods` (`billing.manage`,
`Cache-Control: no-store`) lists:

- the **enabled manual methods** that have a number, for charges in EGP,
  each with its `accountNumber`, its `paymentLink` (an https link such as an
  InstaPay link, or `null`: show the number only) and its note;
- the **enabled gateways whose adapter is configured**. For Fawaterak that
  means `ONLINE_BILLING_ENABLED=true` and its `FAWATERAK_*` keys, the same rule
  the Pay button has always had.

An empty list comes back with `contactSupport: true`.

Migration 130 seeds `instapay` and `wallet`, both off and without a number.

## Paying by transfer

1. `POST /billing/invoices/open`: the charge to pay now and the methods
   offered (`methods`), **writing nothing**. It's the open charge if there is
   one (`written: true`), otherwise the next period priced as `createCharge`
   would write it, with the id `next` and `createdAt: null`. So opening the
   Pay window never holds the plan. Only while some method is offered
   (otherwise 409 `NO_PAYMENT_METHOD`). Always 200; `created` is always false.
2. `POST /billing/invoices/:invoiceId/payment-proofs`, multipart, where
   `:invoiceId` is an open charge of the store or `next`:
   - `methodCode`: an enabled manual method;
   - `senderPhone`: the Egyptian mobile number it came from, normalised by
     `normalizePhone`;
   - `file`: the screenshot. JPEG, PNG or WebP by its bytes, at most 8 MB,
     re-encoded without metadata and stored privately under
     `payment-proofs/<workspaceId>/`;
   - `expectedAmount` (optional): the amount the merchant was shown, in minor
     units. Only compared: if the charge comes to anything else, 409
     `CHARGE_AMOUNT_CHANGED` with `details.amountDue`, and nothing is written.

   For `next`, the charge is written (or the open one taken) in the proof's
   own transaction, by `createCharge`'s rules, with the subscription row
   locked: a refused proof leaves no charge, and two proofs sent at once
   write one charge (the second gets `PROOF_ALREADY_OPEN`). From then on the
   charge is open, so a plan change answers `OPEN_CHARGE_EXISTS` as before.

   The rules on a proof:
   - **The amount is the server's:** the charge's amount payable now, frozen
     with its discount and referral code.
   - **One screenshot is never accepted twice:** its SHA-256 is unique.
   - **Waiting proofs:** one per charge, and at most 3 per store.
   - **Rate limit:** 10 an hour per account.
3. `GET /billing/payment-proofs` shows each proof's state, with the note of
   a rejection.

## Reviewing a proof (console)

All of these need `payments.record`.

- `GET /admin/payment-proofs?status=` and `GET /admin/payment-proofs/:id`:
  the proof, its charge, what would stop an approval, and the image through
  a link signed for 5 minutes (`GET /payment-proofs/:id/image`).
- `POST /admin/payment-proofs/:id/approve { receivedAmount }`:
  - The amount must be **exactly** the amount asked, the charge still
    unpaid and not re-priced since. Otherwise nothing is settled and the
    proof is rejected instead.
  - The charge is settled through `settlePaid`, the path every payment
    takes, as a manual payment (it can be reversed like one).
  - Approving twice changes nothing.
- `POST /admin/payment-proofs/:id/reject { note }`: the note is required, and
  the merchant reads it.

## Managing the methods (console)

| Endpoint | Permission |
|---|---|
| `GET /admin/payment-methods` | `payments.record` |
| `PATCH /admin/payment-methods/:code` (on/off, labels) | `payment_methods.manage` |
| `PUT /admin/payment-methods/order` | `payment_methods.manage` |
| `PATCH /admin/payment-methods/:code/account` (a manual method's number, payment link and note) | `payment_methods.edit_numbers` |

- The two `payment_methods.*` keys belong to the creator (`*`). No migration
  gives them to admins.
- A number change is audited with the old and the new value.
- `paymentLink` (migration 210) is optional: an empty string or `null`
  clears it, a given link must be https (422 otherwise). Same permission as
  the number, audited the same way.
- A gateway with an adapter but no row is listed as not added; turning it
  on creates its row.

## Adding a gateway

1. Write `src/modules/billing/gateways/adapters/<code>.js`. The interface is
   documented in `gateways/registry.js`:
   - `canStart`, `assertCanStart`, `canConfirm`, `missing` (variable names
     only);
   - `createPayment` → a hosted checkout for exactly the attempt's amount;
   - `fetchPayment` → what the gateway's own API says now.

   A webhook only ever says when to call `fetchPayment`. The same checks
   apply to every gateway: the reference, the exact amount and the currency.
2. Turn its row on in the console.

Nothing in the charge logic changes. An adapter can also be added at run time
with `gateways/registry.register(adapter)` (and taken away with `unregister`).
