# The prepaid balance and the pay-per-order plan

Behind `WALLET_ENABLED` (only `true` turns it on). With it off nothing below
happens: no fee is charged, no plan with a fee is offered, and no top-up is
taken.

There's one exception. A fee charged while it was on is still given back when
its order is cancelled after it goes off.

Code: `src/modules/billing/walletService.js`. Migration 131.

## The plan

- **A pay-per-order plan:** a plan with `per_order_fee_amount > 0` (minor
  units: 50 = EGP 0.50), nothing monthly, in EGP.
- **Setting the fee:** the console's plan editor refuses a fee on any other
  plan (`PER_ORDER_FEE_NOT_ALLOWED`).
- **Where it's offered:** never as a default plan, a public plan, a sign-up
  choice or a regular card. It has its own card in the Subscription section.
- **Choosing it:** a draft or a trial chooses it at once
  (`POST /workspaces/:id/billing/pay-per-order`), with a period of 100 years
  and nothing to pay. A paid subscription changes through support.

## The fee

- **When it's charged:** in `orderService.createOrder`, after `Order.create`,
  as the transaction's last lock. Charged while the subscription is `active` on
  the plan.
- **When it's refused:** when the balance would fall below
  `-OVERDRAFT_LIMIT` (EGP 10). The refusal rolls the order back:
  - staff get 402 `WALLET_BALANCE_TOO_LOW`;
  - a shopper gets 423 `STORE_UNAVAILABLE`.
- **Funnel add-ons:** an add-on placed as its own order pays none (Q14).
- **Given back:** the merchant cancels, a confirmation call rejects, an
  online order expires unpaid, or a payment arrives for a blocklisted
  customer.
- **Charged again** (`order_fee_recharge`, past the overdraft): a rejection
  is corrected to confirmed, or a late payment reopens the order.
- **Never moved** once a parcel has shipped.
- **Idempotency:**
  - every entry has a unique key: `order_fee:<order>:<n>`,
    `order_fee_reversal:<order>:<n>`, `order_fee_recharge:<order>:<n>`,
    `topup:<proof>`;
  - the order's state is read from its own entries under the wallet lock;
  - so a repeated event moves nothing, and charge → give back → charge again
    works.

## The restriction

`workspaceAccessService.accessFor` gets a third reason, `balance`: the next
order's fee can't be paid within the overdraft.

- **Shoppers** see the store as unavailable (423).
- **Dashboard banner:** warns below 20 orders before the overdraft, again at
  zero, and says when the store stopped selling.
- **Product and funnel creation** stay open.
- **`BILLING_RESTRICTIONS`** doesn't apply to it (Q17).

## Top-ups

A transfer's proof, the same flow as paying an invoice
([billing-payment-methods.md](billing-payment-methods.md)), with
`purpose = 'topup'`:

- **The request:** `POST /workspaces/:id/billing/wallet/topups` with an
  amount between `MIN_TOPUP_AMOUNT` (EGP 100) and `MAX_TOPUP_AMOUNT`
  (EGP 20,000).
- **Waiting:** at most `MAX_OPEN_TOPUPS` (3).
- **The credit:** the console credits **what arrived**, shown beside what was
  asked. Once per proof.

There are no refunds and no promotional balance.

## The ledger

- **`wallet_ledger_entries` is append-only.** A trigger refuses UPDATE and
  DELETE, and `workspace_wallets.cash_balance` is a cache of it.
- **`node scripts/check-wallet-ledger.js`** (read-only) compares the two per
  store. Exit codes: 0 all match, 2 a difference, 1 couldn't run.
- **A reset of the data:** `TRUNCATE wallet_ledger_entries, workspace_wallets`
  works, because TRUNCATE fires no row trigger. Deleting a store takes its rows
  along (the trigger lets a row go once its workspace is gone).
- **What the trigger refuses:** a `DELETE FROM wallet_ledger_entries` aimed at
  rows of a store that still exists.

## Endpoints

| | |
|---|---|
| `GET /workspaces/:id/billing/wallet` | balance, fee, orders left, this month in Cairo, limits |
| `GET /workspaces/:id/billing/wallet/ledger?page&pageSize` | the entries, newest first |
| `POST /workspaces/:id/billing/wallet/topups` | multipart: `requestedAmount`, `methodCode`, `senderPhone`, `file` |
| `POST /workspaces/:id/billing/pay-per-order` | choose the plan (a confirmed account) |
| `GET /admin/workspaces/:id/wallet` | the console's panel (`subscriptions.view`) |
