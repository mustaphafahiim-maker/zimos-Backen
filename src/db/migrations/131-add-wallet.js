'use strict';

/**
 * The prepaid balance behind the pay-per-order plan (billing/walletService),
 * all of it inert while WALLET_ENABLED is off.
 *
 * plans.per_order_fee_amount
 *   the fee one order costs on this plan, in minor units (50 = EGP 0.50).
 *   0 = no fee, which every existing plan keeps.
 *
 * workspace_wallets
 *   one row per store, made on its first ledger entry: the balance (it may go
 *   below zero down to the overdraft the code allows) and the total ever
 *   topped up. A cache of the ledger, written in the same transaction as
 *   each entry; scripts/check-wallet-ledger.js compares the two.
 *
 * wallet_ledger_entries
 *   every change to a balance, append-only: a trigger refuses UPDATE and
 *   DELETE. TRUNCATE (a reset of the whole table) is not a row change and is
 *   allowed, and so is a DELETE cascading from the store's own deletion (the
 *   trigger lets a row go once its workspace no longer exists). Each entry has
 *   a unique idempotency key, so the same event never moves money twice:
 *     topup:<proofId>                 a transfer approved in the console
 *     order_fee:<orderId>:<n>         the fee for an order
 *     order_fee_reversal:<orderId>:<n> the fee given back (cancelled, rejected, expired)
 *     order_fee_recharge:<orderId>:<n> charged again when the order comes back
 *   order_id and payment_proof_id carry no foreign key on purpose: a key
 *   would have to SET NULL or CASCADE, which is an UPDATE or DELETE the
 *   ledger refuses.
 *
 * payment_proofs
 *   a proof may now be for a top-up (purpose 'topup', no invoice): the amount
 *   is the merchant's request, and the console credits what arrived.
 *
 * Written to be harmless if it runs again (IF NOT EXISTS, CREATE OR REPLACE,
 * constraints dropped before they are added). Down keeps any top-up proof:
 * the old purpose check comes back NOT VALID, so it binds new rows only.
 */

const ENTRY_TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await run('ALTER TABLE plans ADD COLUMN IF NOT EXISTS per_order_fee_amount BIGINT NOT NULL DEFAULT 0');
      await run('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_per_order_fee_check');
      await run('ALTER TABLE plans ADD CONSTRAINT plans_per_order_fee_check CHECK (per_order_fee_amount >= 0)');

      await run(`
        CREATE TABLE IF NOT EXISTS workspace_wallets (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE
            CONSTRAINT workspace_wallets_workspace_key UNIQUE,
          currency CHAR(3) NOT NULL DEFAULT 'EGP' CONSTRAINT workspace_wallets_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
          cash_balance BIGINT NOT NULL DEFAULT 0,
          total_topped_up BIGINT NOT NULL DEFAULT 0 CONSTRAINT workspace_wallets_topped_up_check CHECK (total_topped_up >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

      await run(`
        CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE,
          entry_type VARCHAR(30) NOT NULL CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(ENTRY_TYPES)})),
          cash_delta BIGINT NOT NULL CONSTRAINT wallet_ledger_entries_delta_check CHECK (cash_delta <> 0),
          balance_after BIGINT NOT NULL,
          currency CHAR(3) NOT NULL,
          order_id UUID,
          payment_proof_id UUID,
          actor_user_id UUID,
          note VARCHAR(500),
          idempotency_key VARCHAR(120) NOT NULL CONSTRAINT wallet_ledger_entries_idempotency_key UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await run('CREATE INDEX IF NOT EXISTS wallet_ledger_entries_workspace_idx ON wallet_ledger_entries (workspace_id, created_at)');
      await run('CREATE INDEX IF NOT EXISTS wallet_ledger_entries_order_idx ON wallet_ledger_entries (order_id) WHERE order_id IS NOT NULL');

      await run(`
        CREATE OR REPLACE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger AS $$
        BEGIN
          -- The store itself is being deleted (ON DELETE CASCADE): let its rows go.
          IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'wallet_ledger_entries is append-only: % refused', TG_OP USING ERRCODE = 'restrict_violation';
        END;
        $$ LANGUAGE plpgsql`);
      await run('DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only ON wallet_ledger_entries');
      await run(`CREATE TRIGGER wallet_ledger_entries_append_only
                   BEFORE UPDATE OR DELETE ON wallet_ledger_entries
                   FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()`);

      await run('ALTER TABLE payment_proofs DROP CONSTRAINT IF EXISTS payment_proofs_purpose_check');
      await run("ALTER TABLE payment_proofs ADD CONSTRAINT payment_proofs_purpose_check CHECK (purpose IN ('invoice', 'topup'))");
      await run('ALTER TABLE payment_proofs DROP CONSTRAINT IF EXISTS payment_proofs_topup_check');
      await run("ALTER TABLE payment_proofs ADD CONSTRAINT payment_proofs_topup_check CHECK (purpose <> 'topup' OR billing_invoice_id IS NULL)");
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run('ALTER TABLE payment_proofs DROP CONSTRAINT IF EXISTS payment_proofs_topup_check');
      await run('ALTER TABLE payment_proofs DROP CONSTRAINT IF EXISTS payment_proofs_purpose_check');
      await run("ALTER TABLE payment_proofs ADD CONSTRAINT payment_proofs_purpose_check CHECK (purpose IN ('invoice')) NOT VALID");
      await run('DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only ON wallet_ledger_entries');
      await run('DROP FUNCTION IF EXISTS wallet_ledger_entries_append_only()');
      await run('DROP TABLE IF EXISTS wallet_ledger_entries');
      await run('DROP TABLE IF EXISTS workspace_wallets');
      await run('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_per_order_fee_check');
      await run('ALTER TABLE plans DROP COLUMN IF EXISTS per_order_fee_amount');
    });
  },
};
