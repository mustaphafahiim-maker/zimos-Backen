'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A store's own manual payment methods (InstaPay, a mobile wallet) and, per
 * order paid by one, the shopper's proof: the number they paid from, a
 * screenshot (a private customer_uploads row) and the merchant's review
 * (modules/manualPayments). Platform subscription payments are elsewhere
 * (payment_methods / payment_proofs, migration 130).
 */
const KINDS = ['instapay', 'wallet'];
const STATUSES = ['awaiting_proof', 'submitted', 'approved', 'rejected'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') };
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'store_payment_methods',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
          kind: { type: DataTypes.STRING(10), allowNull: false },
          label: { type: DataTypes.STRING(80), allowNull: false },
          account_number: { type: DataTypes.STRING(80), allowNull: false },
          payment_link: { type: DataTypes.STRING(500), allowNull: true },
          instructions: { type: DataTypes.STRING(1000), allowNull: true },
          active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
          sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          created_at: now,
          updated_at: now,
        },
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE store_payment_methods DROP CONSTRAINT IF EXISTS store_payment_methods_kind_check', { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE store_payment_methods ADD CONSTRAINT store_payment_methods_kind_check CHECK (kind IN (${list(KINDS)}))`,
        { transaction }
      );
      await queryInterface.addIndex('store_payment_methods', ['workspace_id', 'sort_order'], {
        name: 'store_payment_methods_workspace_sort_idx',
        transaction,
      });

      await queryInterface.createTable(
        'order_manual_payments',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
          order_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
          method_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'store_payment_methods', key: 'id' }, onDelete: 'SET NULL' },
          // The method as the shopper saw it at checkout.
          kind: { type: DataTypes.STRING(10), allowNull: false },
          label: { type: DataTypes.STRING(80), allowNull: false },
          account_number: { type: DataTypes.STRING(80), allowNull: false },
          payment_link: { type: DataTypes.STRING(500), allowNull: true },
          instructions: { type: DataTypes.STRING(1000), allowNull: true },
          status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'awaiting_proof' },
          payer_number: { type: DataTypes.STRING(60), allowNull: true },
          proof_upload_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'customer_uploads', key: 'id' }, onDelete: 'SET NULL' },
          submitted_at: { type: DataTypes.DATE, allowNull: true },
          reviewed_at: { type: DataTypes.DATE, allowNull: true },
          reviewed_by_user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
          rejection_reason: { type: DataTypes.STRING(500), allowNull: true },
          created_at: now,
          updated_at: now,
        },
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE order_manual_payments DROP CONSTRAINT IF EXISTS order_manual_payments_kind_check', { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE order_manual_payments ADD CONSTRAINT order_manual_payments_kind_check CHECK (kind IN (${list(KINDS)}))`,
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE order_manual_payments DROP CONSTRAINT IF EXISTS order_manual_payments_status_check', { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE order_manual_payments ADD CONSTRAINT order_manual_payments_status_check CHECK (status IN (${list(STATUSES)}))`,
        { transaction }
      );
      await queryInterface.addIndex('order_manual_payments', ['order_id'], { name: 'order_manual_payments_order_id_uq', unique: true, transaction });
      await queryInterface.addIndex('order_manual_payments', ['workspace_id', 'status'], { name: 'order_manual_payments_workspace_status_idx', transaction });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS order_manual_payments');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS store_payment_methods');
  },
};
