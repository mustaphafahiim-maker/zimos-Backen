'use strict';

/**
 * Refunds of the prepaid balance (billing/walletRefundService) and a gift
 * credit from the console (billing/walletService). Inert while WALLET_ENABLED
 * is off.
 *
 * wallet_refund_requests
 *   a merchant's request to get unused balance back: requested → approved →
 *   paid (paid out by hand outside the system, with its reference), or
 *   rejected / cancelled. One open (requested or approved) per store, by a
 *   unique partial index. `request_key` makes a repeated request one row.
 *
 * wallet_refund_allocations
 *   which paid top-ups (wallet_ledger_entries rows of type topup) a request
 *   takes its amount from: each top-up gives back at most a share of what was
 *   paid for it (WALLET_REFUND_CEILING_BP), less what requests still open or
 *   paid already took from it. A rejected or cancelled request's rows stay
 *   for the record and count for nothing. No foreign key to the ledger, as
 *   for order_id there: the ledger is truncated on a reset.
 *
 * wallet_ledger_entries
 *   new types: refund_hold (the amount taken off the balance when asked, so
 *   it can't be spent), refund_release (given back on a rejection or a
 *   cancellation), refund_paid (a marker with no money when it's paid out:
 *   the hold already took it), gift (credit from the console, never
 *   refundable). refund_request_id links an entry to its request.
 *
 * Written to be harmless if it runs again. Down drops the two tables and
 * keeps every ledger row: the old checks come back NOT VALID.
 */

const TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge', 'free_orders_grant', 'adjustment', 'gift', 'refund_hold', 'refund_release', 'refund_paid'];
const OLD_TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge', 'free_orders_grant', 'adjustment'];
const STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'paid'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await run(`
        CREATE TABLE IF NOT EXISTS wallet_refund_requests (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE,
          amount BIGINT NOT NULL CONSTRAINT wallet_refund_requests_amount_check CHECK (amount > 0),
          currency CHAR(3) NOT NULL DEFAULT 'EGP',
          status VARCHAR(12) NOT NULL CONSTRAINT wallet_refund_requests_status_check CHECK (status IN (${list(STATUSES)})),
          payout_method VARCHAR(30),
          payout_account VARCHAR(120),
          payout_reference VARCHAR(200),
          admin_note VARCHAR(500),
          request_key VARCHAR(80) CONSTRAINT wallet_refund_requests_request_key UNIQUE,
          requested_by_user_id UUID,
          reviewed_by_user_id UUID,
          paid_by_user_id UUID,
          approved_at TIMESTAMPTZ,
          rejected_at TIMESTAMPTZ,
          cancelled_at TIMESTAMPTZ,
          paid_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await run(
        "CREATE UNIQUE INDEX IF NOT EXISTS wallet_refund_requests_one_open_idx ON wallet_refund_requests (workspace_id) WHERE status IN ('requested', 'approved')"
      );
      await run('CREATE INDEX IF NOT EXISTS wallet_refund_requests_status_idx ON wallet_refund_requests (status, created_at)');
      await run('CREATE INDEX IF NOT EXISTS wallet_refund_requests_workspace_idx ON wallet_refund_requests (workspace_id, created_at)');

      await run(`
        CREATE TABLE IF NOT EXISTS wallet_refund_allocations (
          id UUID PRIMARY KEY,
          refund_request_id UUID NOT NULL REFERENCES wallet_refund_requests (id) ON DELETE CASCADE ON UPDATE CASCADE,
          workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE,
          topup_entry_id UUID NOT NULL,
          amount BIGINT NOT NULL CONSTRAINT wallet_refund_allocations_amount_check CHECK (amount > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT wallet_refund_allocations_request_topup UNIQUE (refund_request_id, topup_entry_id)
        )`);
      await run('CREATE INDEX IF NOT EXISTS wallet_refund_allocations_workspace_idx ON wallet_refund_allocations (workspace_id, topup_entry_id)');

      await run('ALTER TABLE wallet_ledger_entries ADD COLUMN IF NOT EXISTS refund_request_id UUID');
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_type_check');
      await run(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(TYPES)}))`);
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_delta_check');
      await run(
        "ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_delta_check CHECK (cash_delta <> 0 OR free_orders_delta <> 0 OR entry_type = 'refund_paid')"
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_delta_check');
      await run('ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_delta_check CHECK (cash_delta <> 0 OR free_orders_delta <> 0) NOT VALID');
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_type_check');
      await run(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(OLD_TYPES)})) NOT VALID`);
      await run('ALTER TABLE wallet_ledger_entries DROP COLUMN IF EXISTS refund_request_id');
      await run('DROP TABLE IF EXISTS wallet_refund_allocations');
      await run('DROP TABLE IF EXISTS wallet_refund_requests');
    });
  },
};
