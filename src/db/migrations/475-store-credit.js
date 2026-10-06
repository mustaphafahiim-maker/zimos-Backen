'use strict';

/**
 * Store credit (modules/storeCredit, spec-gaps item 204): money a customer
 * holds at the store (minor units, store currency) — given by staff or by a
 * refund to store credit, spent at checkout.
 * store_credit_transactions kinds: grant, refund_credit (a refund paid as
 * credit), redeem, hold, hold_released, release, refund (a refund of a
 * credit payment), adjust.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('customers', 'store_credit_amount', { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 });
    await queryInterface.createTable('store_credit_transactions', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      amount: { type: Sequelize.BIGINT, allowNull: false },
      balance_after: { type: Sequelize.BIGINT, allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      order_id: { type: Sequelize.UUID, allowNull: true },
      payment_id: { type: Sequelize.UUID, allowNull: true },
      refund_id: { type: Sequelize.UUID, allowNull: true },
      note: { type: Sequelize.STRING(200), allowNull: true },
      actor_user_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('store_credit_transactions', ['customer_id', 'created_at'], { name: 'store_credit_tx_customer_idx' });
    await queryInterface.addIndex('store_credit_transactions', ['order_id'], { name: 'store_credit_tx_order_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('store_credit_transactions');
    await queryInterface.removeColumn('customers', 'store_credit_amount');
  },
};
