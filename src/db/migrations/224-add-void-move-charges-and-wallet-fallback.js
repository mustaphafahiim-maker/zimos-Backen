'use strict';

/**
 * A plan move never traps a store, and a store whose subscription ends with
 * a prepaid balance falls back to pay per order (billing/planMoveService,
 * billing/walletFallbackService).
 *
 * billing_invoices.status 'void', voided_at, void_reason
 *   a move's charge that no longer asks for money: cancelled by the merchant,
 *   replaced by another move, or expired unpaid (WALLET_MOVE_EXPIRY_HOURS).
 *   Not due, not owed, never dunned; the subscription is not touched. A
 *   payment that still arrives for one is applied or credited
 *   (subscriptionChargeService.settleLateMovePayment).
 *
 * wallet_ledger_entries type 'move_payment_credit'
 *   money paid for a move that could no longer be applied, credited to the
 *   balance. Not a top-up, so not refundable by request.
 *
 * platform_notifications type 'wallet_fallback'
 *   the console told that a store fell back to pay per order. The CHECKs are
 *   read and extended (as in migration 219), so other types are kept.
 *
 * Harmless if it runs again. Down: void charges become failed with their
 * reason, the enum loses 'void' (rebuilt, as migration 068 does), and the
 * old checks come back NOT VALID so existing rows stay.
 */

const LEDGER_TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge', 'free_orders_grant', 'adjustment', 'gift', 'refund_hold', 'refund_release', 'refund_paid', 'move_payment_credit'];
const OLD_LEDGER_TYPES = LEDGER_TYPES.filter((t) => t !== 'move_payment_credit');
const NOTIFICATION_CHECKS = [
  ['platform_notifications', 'platform_notifications_type_check'],
  ['platform_notification_prefs', 'platform_notification_prefs_type_check'],
];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

async function notificationTypes(queryInterface, name, transaction) {
  const [rows] = await queryInterface.sequelize.query('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = :name', {
    replacements: { name },
    transaction,
  });
  if (rows.length === 0) return null;
  return [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

async function setNotificationTypes(queryInterface, change, transaction, { notValid = false } = {}) {
  for (const [table, name] of NOTIFICATION_CHECKS) {
    const current = await notificationTypes(queryInterface, name, transaction);
    if (!current) continue;
    const next = change(current);
    if (next.length === current.length && next.every((t) => current.includes(t))) continue;
    await queryInterface.sequelize.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`, { transaction });
    await queryInterface.sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (type IN (${list(next)}))${notValid ? ' NOT VALID' : ''}`, {
      transaction,
    });
  }
}

module.exports = {
  up: async (queryInterface) => {
    // An enum value is added outside the transaction below (as migration 068 does).
    await queryInterface.sequelize.query(`ALTER TYPE "enum_billing_invoices_status" ADD VALUE IF NOT EXISTS 'void'`);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run('ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ');
      await run('ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS void_reason VARCHAR(20)');
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_void_reason_check');
      await run(
        "ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_void_reason_check CHECK (void_reason IS NULL OR void_reason IN ('cancelled', 'replaced', 'expired'))"
      );

      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_type_check');
      await run(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(LEDGER_TYPES)}))`);

      await setNotificationTypes(queryInterface, (types) => (types.includes('wallet_fallback') ? types : [...types, 'wallet_fallback']), transaction);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run("DELETE FROM platform_notifications WHERE type = 'wallet_fallback'");
      await run("DELETE FROM platform_notification_prefs WHERE type = 'wallet_fallback'");
      await setNotificationTypes(queryInterface, (types) => types.filter((t) => t !== 'wallet_fallback'), transaction);

      await run('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_type_check');
      await run(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_type_check CHECK (entry_type IN (${list(OLD_LEDGER_TYPES)})) NOT VALID`);

      const [[{ exists: hasColumn }]] = await queryInterface.sequelize.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_invoices' AND column_name = 'void_reason') AS exists`,
        { transaction }
      );
      if (hasColumn) {
        await run(
          "UPDATE billing_invoices SET status = 'failed', failure_reason = COALESCE(failure_reason, 'Move ' || COALESCE(void_reason, 'voided') || ' (migration 224 down).') WHERE status::text = 'void'"
        );
      }
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_void_reason_check');
      await run('ALTER TABLE billing_invoices DROP COLUMN IF EXISTS void_reason');
      await run('ALTER TABLE billing_invoices DROP COLUMN IF EXISTS voided_at');

      const [values] = await queryInterface.sequelize.query(
        "SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'enum_billing_invoices_status'",
        { transaction }
      );
      if (values.some((v) => v.enumlabel === 'void')) {
        // What names the enum (the one-pending index, two checks) is rebuilt around the swap.
        const [checks] = await queryInterface.sequelize.query(
          "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'billing_invoices'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%enum_billing_invoices_status%'",
          { transaction }
        );
        for (const c of checks) await run(`ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS ${c.conname}`);
        await run('DROP INDEX IF EXISTS billing_invoices_one_pending_idx');
        await run('ALTER TABLE billing_invoices ALTER COLUMN status DROP DEFAULT');
        await run('ALTER TYPE "enum_billing_invoices_status" RENAME TO "enum_billing_invoices_status_old"');
        await run(`CREATE TYPE "enum_billing_invoices_status" AS ENUM ('pending', 'paid', 'failed')`);
        await run('ALTER TABLE billing_invoices ALTER COLUMN status TYPE "enum_billing_invoices_status" USING status::text::"enum_billing_invoices_status"');
        await run("ALTER TABLE billing_invoices ALTER COLUMN status SET DEFAULT 'pending'");
        await run('DROP TYPE "enum_billing_invoices_status_old"');
        await run("CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_one_pending_idx ON billing_invoices (subscription_id) WHERE status = 'pending'");
        for (const c of checks) await run(`ALTER TABLE billing_invoices ADD CONSTRAINT ${c.conname} ${c.def}`);
      }
    });
  },
};
