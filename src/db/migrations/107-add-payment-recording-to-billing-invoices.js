'use strict';

/**
 * Recording how a subscription charge was actually paid (billing module).
 *
 * billing_invoices:
 *   amount_paid          what was actually received. `amount` stays the
 *                        amount due; the two differ when a payment recorded
 *                        by hand was short or over. Set when the charge is
 *                        paid; existing paid rows are backfilled with amount.
 *   payment_note         free text from the person who recorded a payment.
 *   recorded_by_user_id  the platform user who recorded it by hand; NULL for
 *                        a payment that came from the gateway webhook.
 *
 * And a new platform permission, `payments.record` (pricing a workspace's
 * next charge and recording a payment against it by hand). Creators hold it
 * through '*'. It is added to the admin role's default set, and to existing
 * admin accounts that can already manage subscriptions — an admin whose set
 * a creator narrowed below that does not gain it silently.
 */

const KEY = 'payments.record';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'billing_invoices',
        'amount_paid',
        { type: DataTypes.BIGINT, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'billing_invoices',
        'payment_note',
        { type: DataTypes.TEXT, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'billing_invoices',
        'recorded_by_user_id',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        "UPDATE billing_invoices SET amount_paid = amount WHERE status = 'paid'",
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE billing_invoices
           ADD CONSTRAINT billing_invoices_amount_paid_check
             CHECK (amount_paid IS NULL OR amount_paid >= 0),
           ADD CONSTRAINT billing_invoices_paid_has_amount_check
             CHECK (status <> 'paid' OR amount_paid IS NOT NULL)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `UPDATE platform_roles
            SET default_permissions = array_append(default_permissions, CAST(:key AS varchar(64))),
                updated_at = NOW()
          WHERE key = 'admin' AND NOT (:key = ANY (default_permissions))`,
        { replacements: { key: KEY }, transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE users
            SET platform_permissions = array_append(platform_permissions, CAST(:key AS varchar(64)))
          WHERE platform_role = 'admin'
            AND 'subscriptions.manage' = ANY (platform_permissions)
            AND NOT (:key = ANY (platform_permissions))`,
        { replacements: { key: KEY }, transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'UPDATE users SET platform_permissions = array_remove(platform_permissions, CAST(:key AS varchar(64)))',
        { replacements: { key: KEY }, transaction }
      );
      await queryInterface.sequelize.query(
        'UPDATE platform_roles SET default_permissions = array_remove(default_permissions, CAST(:key AS varchar(64)))',
        { replacements: { key: KEY }, transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE billing_invoices
           DROP CONSTRAINT billing_invoices_paid_has_amount_check,
           DROP CONSTRAINT billing_invoices_amount_paid_check`,
        { transaction }
      );
      await queryInterface.removeColumn('billing_invoices', 'recorded_by_user_id', { transaction });
      await queryInterface.removeColumn('billing_invoices', 'payment_note', { transaction });
      await queryInterface.removeColumn('billing_invoices', 'amount_paid', { transaction });
    });
  },
};
