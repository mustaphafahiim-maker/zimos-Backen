'use strict';

/**
 * Backdated manual payments, and reversing them (billing module).
 *
 * billing_invoices:
 *   payment_source       'gateway' (the signed webhook) or 'manual' (recorded
 *                        in the platform console); NULL until paid. Only a
 *                        manual payment can be reversed: gateway money really
 *                        moved. Explicit rather than inferred from
 *                        recorded_by_user_id, which goes NULL if that user is
 *                        ever deleted.
 *   payment_recorded_at  when a manual payment was recorded. paid_at is the
 *                        date the money arrived, which the person recording
 *                        it may set in the past.
 *   Existing paid rows are backfilled: manual when someone recorded them,
 *   else gateway, and a manual row's recorded-at is its paid_at (the two were
 *   the same moment before this migration).
 *
 * agent_commissions: a ledger row is VOIDED, not deleted, when the payment
 * behind it is reversed. The ledger is financial history (like invoices,
 * which are never mutated — refunds add credit notes), and the agent may
 * already have been paid for the row. payout_status is left as it was: only
 * a person marking a row paid ever writes it.
 *   voided_at, voided_by_admin_id, void_reason
 * The one-row-per-invoice index becomes one LIVE row per invoice, so a charge
 * reversed and paid again gets a fresh row next to the voided one.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'billing_invoices',
        'payment_source',
        { type: DataTypes.STRING(10), allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'billing_invoices',
        'payment_recorded_at',
        { type: DataTypes.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE billing_invoices
            SET payment_source = CASE WHEN recorded_by_user_id IS NOT NULL THEN 'manual' ELSE 'gateway' END,
                payment_recorded_at = CASE WHEN recorded_by_user_id IS NOT NULL THEN paid_at END
          WHERE status = 'paid'`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE billing_invoices
           ADD CONSTRAINT billing_invoices_payment_source_check
             CHECK (payment_source IS NULL OR (payment_source IN ('gateway', 'manual') AND status = 'paid'))`,
        { transaction }
      );

      await queryInterface.addColumn(
        'agent_commissions',
        'voided_at',
        { type: DataTypes.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'agent_commissions',
        'voided_by_admin_id',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'agent_commissions',
        'void_reason',
        { type: DataTypes.TEXT, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE agent_commissions
           ADD CONSTRAINT agent_commissions_void_check
             CHECK ((voided_at IS NULL) = (voided_by_admin_id IS NULL))`,
        { transaction }
      );
      await queryInterface.removeIndex('agent_commissions', 'agent_commissions_invoice_idx', { transaction });
      await queryInterface.addIndex('agent_commissions', ['billing_invoice_id'], {
        name: 'agent_commissions_live_invoice_idx',
        unique: true,
        where: { voided_at: null },
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Voided rows would break the old one-row-per-invoice index.
      await queryInterface.sequelize.query('DELETE FROM agent_commissions WHERE voided_at IS NOT NULL', { transaction });
      await queryInterface.removeIndex('agent_commissions', 'agent_commissions_live_invoice_idx', { transaction });
      await queryInterface.addIndex('agent_commissions', ['billing_invoice_id'], {
        name: 'agent_commissions_invoice_idx',
        unique: true,
        transaction,
      });
      await queryInterface.sequelize.query('ALTER TABLE agent_commissions DROP CONSTRAINT agent_commissions_void_check', {
        transaction,
      });
      await queryInterface.removeColumn('agent_commissions', 'void_reason', { transaction });
      await queryInterface.removeColumn('agent_commissions', 'voided_by_admin_id', { transaction });
      await queryInterface.removeColumn('agent_commissions', 'voided_at', { transaction });

      await queryInterface.sequelize.query(
        'ALTER TABLE billing_invoices DROP CONSTRAINT billing_invoices_payment_source_check',
        { transaction }
      );
      await queryInterface.removeColumn('billing_invoices', 'payment_recorded_at', { transaction });
      await queryInterface.removeColumn('billing_invoices', 'payment_source', { transaction });
    });
  },
};
