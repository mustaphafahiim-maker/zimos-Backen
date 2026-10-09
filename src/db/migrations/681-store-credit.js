'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Store credit (modules/storeCredit, STORE_FEATURES store_credit): money a
 * customer holds at the store (minor units, store currency) — given by staff
 * or by a refund to store credit, spent at checkout with cash on delivery.
 * store_credit_transactions kinds: grant, refund_credit (a refund paid as
 * credit), redeem, refund (a refund of a credit payment), adjust — VARCHAR +
 * CHECK. Additive and run-twice safe: customers gets one column with a
 * constant default (no rewrite).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('customers', 'store_credit_amount', { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 });
    const created = await qi.createTable('store_credit_transactions', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      amount: { type: Sequelize.BIGINT, allowNull: false },
      balance_after: { type: Sequelize.BIGINT, allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      // No foreign key: the ledger outlives a deleted order.
      order_id: { type: Sequelize.UUID, allowNull: true },
      payment_id: { type: Sequelize.UUID, allowNull: true },
      refund_id: { type: Sequelize.UUID, allowNull: true },
      note: { type: Sequelize.STRING(200), allowNull: true },
      actor_user_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (created) {
      await queryInterface.sequelize.query("ALTER TABLE store_credit_transactions ADD CONSTRAINT store_credit_transactions_kind_check CHECK (kind IN ('grant', 'refund_credit', 'redeem', 'refund', 'adjust'))");
    }
    await qi.addIndex('store_credit_transactions', ['customer_id', 'created_at'], { name: 'store_credit_tx_customer_idx' });
    await qi.addIndex('store_credit_transactions', ['order_id'], { name: 'store_credit_tx_order_idx' });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.dropTable('store_credit_transactions');
    await qi.removeColumn('customers', 'store_credit_amount');
  },
};
