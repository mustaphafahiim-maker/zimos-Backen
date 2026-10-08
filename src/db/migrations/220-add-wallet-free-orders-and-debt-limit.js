'use strict';

/**
 * Pay-per-order, continued (billing/walletService): free orders, a debt limit
 * set per plan, and the console's own entries. Inert while WALLET_ENABLED is
 * off, and every default keeps what happens today.
 *
 * plans.wallet_free_orders
 *   orders a store on this plan places before any fee is taken from its
 *   balance. 0 = none, which every existing plan keeps.
 *
 * plans.wallet_debt_limit_amount
 *   how far below zero the balance may go, in minor units. NULL = the fixed
 *   overdraft in code (walletService.OVERDRAFT_LIMIT) and today's refusal
 *   (402 for staff, 423 and a restricted store for shoppers), which every
 *   existing plan keeps. Set = this limit, and past it a new order gets 422
 *   WALLET_LIMIT_REACHED while the store stays open.
 *
 * workspace_wallets.free_orders_used, free_orders_granted
 *   caches of the ledger, like cash_balance: free orders used (net of those
 *   given back) and granted by the console.
 *
 * wallet_ledger_entries.free_orders_delta
 *   free orders an entry takes (-1), gives back (+1) or grants (+n). An entry
 *   moves money, free orders or both, never neither: a free order is an
 *   order_fee entry with cash_delta 0 and free_orders_delta -1.
 *   New entry types, both written from the console with a reason:
 *     free_orders_grant:<requestId>   free orders granted to one store
 *     adjustment:<requestId>          the balance corrected by hand
 *
 * Adding columns fires no row trigger, so the ledger's append-only trigger is
 * not in the way. Written to be harmless if it runs again (IF NOT EXISTS,
 * constraints dropped before they are added). Down keeps every row: the old
 * checks come back NOT VALID, so they bind new rows only.
 */

const ENTRY_TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge', 'free_orders_grant', 'adjustment'];
const OLD_ENTRY_TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await run('ALTER TABLE plans ADD COLUMN IF NOT EXISTS wallet_free_orders INTEGER NOT NULL DEFAULT 0');
      await run('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_wallet_free_orders_check');
      await run('ALTER TABLE plans ADD CONSTRAINT plans_wallet_free_orders_check CHECK (wallet_free_orders >= 0)');
      await run('ALTER TABLE plans ADD COLUMN IF NOT EXISTS wallet_debt_limit_amount BIGINT');
      await run('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_wallet_debt_limit_check');
      await run('ALTER TABLE plans ADD CONSTRAINT plans_wallet_debt_limit_check CHECK (wallet_debt_limit_amount IS NULL OR wallet_debt_limit_amount >= 0)');

      await run('ALTER TABLE workspace_wallets ADD COLUMN IF NOT EXISTS free_orders_used INTEGER NOT NULL DEFAULT 0');
      await run('ALTER TABLE workspace_wallets ADD COLUMN IF NOT EXISTS free_orders_granted INTEGER NOT NULL DEFAULT 0');
      await run('ALTER TABLE workspace_wallets DROP CONSTRAINT IF EXISTS workspace_wallets_free_orders_granted_check');
      await run('ALTER TABLE workspace_wallets ADD CONSTRAINT workspace_wallets_free_orders_granted_check CHECK (free_orders_granted >= 0)');

      await run('ALTER TABLE wallet_ledger_entries ADD COLUMN IF NOT EXISTS free_orders_delta INTEGER NOT NULL DEFAULT 0');
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_type_check');
      await run(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(ENTRY_TYPES)}))`);
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_delta_check');
      await run('ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_delta_check CHECK (cash_delta <> 0 OR free_orders_delta <> 0)');
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_delta_check');
      await run('ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_delta_check CHECK (cash_delta <> 0) NOT VALID');
      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_type_check');
      await run(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(OLD_ENTRY_TYPES)})) NOT VALID`);
      await run('ALTER TABLE wallet_ledger_entries DROP COLUMN IF EXISTS free_orders_delta');

      await run('ALTER TABLE workspace_wallets DROP CONSTRAINT IF EXISTS workspace_wallets_free_orders_granted_check');
      await run('ALTER TABLE workspace_wallets DROP COLUMN IF EXISTS free_orders_granted');
      await run('ALTER TABLE workspace_wallets DROP COLUMN IF EXISTS free_orders_used');

      await run('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_wallet_debt_limit_check');
      await run('ALTER TABLE plans DROP COLUMN IF EXISTS wallet_debt_limit_amount');
      await run('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_wallet_free_orders_check');
      await run('ALTER TABLE plans DROP COLUMN IF EXISTS wallet_free_orders');
    });
  },
};
