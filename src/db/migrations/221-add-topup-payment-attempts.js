'use strict';

/**
 * A card top-up of the prepaid balance through Zimos's own gateway
 * (billing/onlineBillingService, billing/walletService): the same attempts
 * table, webhooks, sweep and confirmation as paying a charge online.
 *
 * billing_payment_attempts.purpose
 *   'invoice' (every existing row: paying a subscription charge) or 'topup'
 *   (crediting the balance; no charge). A top-up attempt has no
 *   billing_invoice_id, an invoice attempt always has one (CHECK). Its credit
 *   is the ledger entry topup:attempt:<id>, written once when the gateway's
 *   own API says it is paid.
 *
 * NULLs never clash in the unique "one in progress / one paid per charge"
 * indexes, so they stay as they are and bind invoice attempts only.
 *
 * Written to be harmless if it runs again. Down: a top-up attempt not settled
 * is marked error (the one status the sweep never asks about), the column
 * goes, and NOT NULL comes back only when no top-up row exists; otherwise a
 * NOT VALID check binds new rows.
 */

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run("ALTER TABLE billing_payment_attempts ADD COLUMN IF NOT EXISTS purpose VARCHAR(10) NOT NULL DEFAULT 'invoice'");
      await run('ALTER TABLE billing_payment_attempts DROP CONSTRAINT IF EXISTS billing_payment_attempts_purpose_check');
      await run("ALTER TABLE billing_payment_attempts ADD CONSTRAINT billing_payment_attempts_purpose_check CHECK (purpose IN ('invoice', 'topup'))");
      await run('ALTER TABLE billing_payment_attempts ALTER COLUMN billing_invoice_id DROP NOT NULL');
      await run('ALTER TABLE billing_payment_attempts DROP CONSTRAINT IF EXISTS billing_payment_attempts_invoice_check');
      await run(
        "ALTER TABLE billing_payment_attempts ADD CONSTRAINT billing_payment_attempts_invoice_check CHECK ((purpose = 'invoice') = (billing_invoice_id IS NOT NULL))"
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const [[{ exists: hasColumn }]] = await queryInterface.sequelize.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'billing_payment_attempts' AND column_name = 'purpose') AS exists`,
        { transaction }
      );
      if (hasColumn) {
        await run(
          "UPDATE billing_payment_attempts SET status = 'error', failure_reason = 'Top-up attempts were rolled back (migration 221 down).', updated_at = NOW() WHERE purpose = 'topup' AND status NOT IN ('paid', 'paid_duplicate', 'mismatch', 'error')"
        );
      }
      await run('ALTER TABLE billing_payment_attempts DROP CONSTRAINT IF EXISTS billing_payment_attempts_invoice_check');
      await run('ALTER TABLE billing_payment_attempts DROP CONSTRAINT IF EXISTS billing_payment_attempts_purpose_check');
      await run('ALTER TABLE billing_payment_attempts DROP COLUMN IF EXISTS purpose');
      const [[{ count }]] = await queryInterface.sequelize.query(
        'SELECT COUNT(*)::int AS count FROM billing_payment_attempts WHERE billing_invoice_id IS NULL',
        { transaction }
      );
      await run('ALTER TABLE billing_payment_attempts DROP CONSTRAINT IF EXISTS billing_payment_attempts_invoice_not_null');
      if (count === 0) {
        await run('ALTER TABLE billing_payment_attempts ALTER COLUMN billing_invoice_id SET NOT NULL');
      } else {
        await run(
          'ALTER TABLE billing_payment_attempts ADD CONSTRAINT billing_payment_attempts_invoice_not_null CHECK (billing_invoice_id IS NOT NULL) NOT VALID'
        );
      }
    });
  },
};
