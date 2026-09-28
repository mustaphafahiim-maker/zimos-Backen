'use strict';

/**
 * Agent referral codes and the commission ledger (modules/referrals).
 *
 * referral_codes: one agent, many codes. `code` is stored uppercase and is
 * what a merchant types. The discount is one of:
 *
 *   none        no price change; the code only records who referred them
 *   percentage  discount_value in basis points (1500 = 15.00%), 1..10000
 *   fixed       discount_value in minor units of discount_currency
 *
 * the same units as the merchant discounts table. A fixed amount carries its
 * own currency because plans can be priced in different currencies, and a
 * charge in another currency is never discounted by converting it.
 * commission_rate_bp overrides the platform default (30%) for this code.
 * Codes are never deleted, only deactivated: invoices and ledger rows point
 * at them.
 *
 * subscriptions.referral_code_id: the code the merchant entered, when they
 * entered it. It stays attached for the life of the subscription so it
 * applies to every charge, the first and each renewal.
 *
 * billing_invoices: one row per charge. It now records the plan price
 * (gross_amount), the discount taken off it and the code that gave it, as the
 * code stood when the charge was priced; the charge service re-prices it when
 * it is paid. amount stays the amount charged.
 * At most one pending charge per subscription.
 *
 * agent_commissions: the ledger. One row per paid billing invoice that
 * carried a code — the first payment and every renewal — with the suggested
 * commission worked out at the rate in force then. Informational only:
 * payout_status is flipped to marked_paid by a person, never by the system.
 * Rows block the deletion of their workspace and invoice (RESTRICT) rather
 * than vanishing with them.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const timestamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    };

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'referral_codes',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          agent_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          code: { type: DataTypes.STRING(32), allowNull: false },
          label: { type: DataTypes.STRING(120), allowNull: true },
          discount_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'none' },
          discount_value: { type: DataTypes.BIGINT, allowNull: true },
          discount_currency: { type: DataTypes.STRING(3), allowNull: true },
          commission_rate_bp: { type: DataTypes.INTEGER, allowNull: true },
          active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
          created_by_user_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE referral_codes
           ADD CONSTRAINT referral_codes_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
           ADD CONSTRAINT referral_codes_discount_check CHECK (
             (discount_type = 'none' AND discount_value IS NULL AND discount_currency IS NULL)
             OR (discount_type = 'percentage' AND discount_value BETWEEN 1 AND 10000 AND discount_currency IS NULL)
             OR (discount_type = 'fixed' AND discount_value >= 1 AND discount_currency ~ '^[A-Z]{3}$')
           ),
           ADD CONSTRAINT referral_codes_commission_rate_check
             CHECK (commission_rate_bp IS NULL OR commission_rate_bp BETWEEN 0 AND 10000)`,
        { transaction }
      );
      await queryInterface.addIndex('referral_codes', ['code'], {
        name: 'referral_codes_code_idx',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('referral_codes', ['agent_id'], { name: 'referral_codes_agent_idx', transaction });

      // --- subscriptions: the code the merchant entered ----------------------
      await queryInterface.addColumn(
        'subscriptions',
        'referral_code_id',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'referral_codes', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'subscriptions',
        'referral_code_attached_at',
        { type: DataTypes.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE subscriptions
           ADD CONSTRAINT subscriptions_referral_code_attached_check
           CHECK ((referral_code_id IS NULL) = (referral_code_attached_at IS NULL))`,
        { transaction }
      );
      await queryInterface.addIndex('subscriptions', ['referral_code_id'], {
        name: 'subscriptions_referral_code_idx',
        where: { referral_code_id: { [Sequelize.Op.ne]: null } },
        transaction,
      });

      // --- billing_invoices: how each charge was priced ----------------------
      await queryInterface.addColumn(
        'billing_invoices',
        'gross_amount',
        { type: DataTypes.BIGINT, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query('UPDATE billing_invoices SET gross_amount = amount', { transaction });
      await queryInterface.changeColumn(
        'billing_invoices',
        'gross_amount',
        { type: DataTypes.BIGINT, allowNull: false },
        { transaction }
      );
      await queryInterface.addColumn(
        'billing_invoices',
        'discount_amount',
        { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        { transaction }
      );
      await queryInterface.addColumn(
        'billing_invoices',
        'referral_code_id',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'referral_codes', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'billing_invoices',
        'external_reference',
        { type: DataTypes.STRING(200), allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE billing_invoices
           ADD CONSTRAINT billing_invoices_amounts_check CHECK (
             discount_amount >= 0 AND amount >= 0 AND amount = gross_amount - discount_amount
           )`,
        { transaction }
      );
      // One open charge per subscription: pricing the next one while another
      // is still awaiting payment would bill the same period twice.
      await queryInterface.addIndex('billing_invoices', ['subscription_id'], {
        name: 'billing_invoices_one_pending_idx',
        unique: true,
        where: { status: 'pending' },
        transaction,
      });

      // --- agent_commissions: the ledger -------------------------------------
      await queryInterface.createTable(
        'agent_commissions',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          agent_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          code_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'referral_codes', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          billing_invoice_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'billing_invoices', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          amount_paid: { type: DataTypes.BIGINT, allowNull: false },
          currency: { type: DataTypes.STRING(3), allowNull: false },
          paid_at: { type: DataTypes.DATE, allowNull: false },
          commission_rate_bp: { type: DataTypes.INTEGER, allowNull: false },
          suggested_commission: { type: DataTypes.BIGINT, allowNull: false },
          is_first_payment: { type: DataTypes.BOOLEAN, allowNull: false },
          payout_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
          payout_note: { type: DataTypes.TEXT, allowNull: true },
          marked_paid_by_admin_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          marked_paid_at: { type: DataTypes.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE agent_commissions
           ADD CONSTRAINT agent_commissions_amounts_check
             CHECK (amount_paid >= 0 AND suggested_commission >= 0 AND commission_rate_bp BETWEEN 0 AND 10000),
           ADD CONSTRAINT agent_commissions_payout_check CHECK (
             (payout_status = 'pending' AND marked_paid_at IS NULL AND marked_paid_by_admin_id IS NULL)
             OR (payout_status = 'marked_paid' AND marked_paid_at IS NOT NULL AND marked_paid_by_admin_id IS NOT NULL)
           )`,
        { transaction }
      );
      // One ledger row per payment event.
      await queryInterface.addIndex('agent_commissions', ['billing_invoice_id'], {
        name: 'agent_commissions_invoice_idx',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('agent_commissions', ['agent_id', 'paid_at'], {
        name: 'agent_commissions_agent_paid_idx',
        transaction,
      });
      await queryInterface.addIndex('agent_commissions', ['code_id'], { name: 'agent_commissions_code_idx', transaction });
      await queryInterface.addIndex('agent_commissions', ['workspace_id'], {
        name: 'agent_commissions_workspace_idx',
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('agent_commissions', { transaction });

      await queryInterface.removeIndex('billing_invoices', 'billing_invoices_one_pending_idx', { transaction });
      await queryInterface.sequelize.query(
        'ALTER TABLE billing_invoices DROP CONSTRAINT billing_invoices_amounts_check',
        { transaction }
      );
      await queryInterface.removeColumn('billing_invoices', 'external_reference', { transaction });
      await queryInterface.removeColumn('billing_invoices', 'referral_code_id', { transaction });
      await queryInterface.removeColumn('billing_invoices', 'discount_amount', { transaction });
      await queryInterface.removeColumn('billing_invoices', 'gross_amount', { transaction });

      await queryInterface.removeIndex('subscriptions', 'subscriptions_referral_code_idx', { transaction });
      await queryInterface.sequelize.query(
        'ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_referral_code_attached_check',
        { transaction }
      );
      await queryInterface.removeColumn('subscriptions', 'referral_code_attached_at', { transaction });
      await queryInterface.removeColumn('subscriptions', 'referral_code_id', { transaction });

      await queryInterface.dropTable('referral_codes', { transaction });
    });
  },
};
