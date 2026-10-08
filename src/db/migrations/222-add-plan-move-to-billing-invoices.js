'use strict';

/**
 * A store on the pay-per-order plan moving to a monthly or annual plan by
 * itself (billing/merchantPlansService.requestPlanMove): the move is one
 * ordinary charge, priced for the plan it moves to, and the plan switches
 * only when that charge is paid (subscriptionChargeService.settlePaid).
 *
 * billing_invoices.target_plan_id, target_billing_cycle
 *   set on a move's charge only: the plan and cycle the store moves to when
 *   it is paid. NULL on every other charge, which keeps today's meaning.
 *   Both or neither (CHECK). A plan a pending move points at can't be
 *   deleted from under it (ON DELETE RESTRICT).
 *
 * plan_trials.source 'pay_per_order'
 *   an account whose store used the pay-per-order plan has had its free
 *   trial: a move never starts one, and the account's next store gets none.
 *
 * Written to be harmless if it runs again. Down: a move still unpaid is
 * marked failed (so nobody pays it as a charge of the old plan), the columns
 * go, and the old source check comes back NOT VALID so existing rows stay.
 */

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run('ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS target_plan_id UUID');
      await run('ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS target_billing_cycle VARCHAR(10)');
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_target_plan_fk');
      await run(
        'ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_target_plan_fk FOREIGN KEY (target_plan_id) REFERENCES plans (id) ON DELETE RESTRICT ON UPDATE CASCADE'
      );
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_target_check');
      await run(
        `ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_target_check
           CHECK ((target_plan_id IS NULL) = (target_billing_cycle IS NULL)
                  AND (target_billing_cycle IS NULL OR target_billing_cycle IN ('monthly', 'yearly')))`
      );

      await run('ALTER TABLE plan_trials DROP CONSTRAINT IF EXISTS plan_trials_source_check');
      await run(
        "ALTER TABLE plan_trials ADD CONSTRAINT plan_trials_source_check CHECK (source IN ('store_created', 'start_trial', 'backfill', 'pay_per_order'))"
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const [[{ exists: hasColumn }]] = await queryInterface.sequelize.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'billing_invoices' AND column_name = 'target_plan_id') AS exists`,
        { transaction }
      );
      if (hasColumn) {
        await run(
          "UPDATE billing_invoices SET status = 'failed', failure_reason = 'Plan move rolled back (migration 222 down).', updated_at = NOW() WHERE target_plan_id IS NOT NULL AND status = 'pending'"
        );
      }
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_target_check');
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_target_plan_fk');
      await run('ALTER TABLE billing_invoices DROP COLUMN IF EXISTS target_billing_cycle');
      await run('ALTER TABLE billing_invoices DROP COLUMN IF EXISTS target_plan_id');

      await run('ALTER TABLE plan_trials DROP CONSTRAINT IF EXISTS plan_trials_source_check');
      await run(
        "ALTER TABLE plan_trials ADD CONSTRAINT plan_trials_source_check CHECK (source IN ('store_created', 'start_trial', 'backfill')) NOT VALID"
      );
    });
  },
};
