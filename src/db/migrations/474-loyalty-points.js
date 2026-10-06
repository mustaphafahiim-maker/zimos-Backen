'use strict';

/**
 * Loyalty points (modules/loyalty, spec-gaps item 203).
 * - customers.loyalty_points: the balance; loyalty_activity_at: the last
 *   earn or spend, from which inactive balances expire.
 * - loyalty_transactions: every change — earn, redeem, hold (for an unpaid
 *   online order), hold_released, release, refund, reverse, expire, adjust.
 *   `amount` is the money a redeem/hold stands for (minor units).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('customers', 'loyalty_points', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('customers', 'loyalty_activity_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.createTable('loyalty_transactions', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      points: { type: Sequelize.INTEGER, allowNull: false },
      balance_after: { type: Sequelize.INTEGER, allowNull: false },
      amount: { type: Sequelize.BIGINT, allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: true },
      // No FK: the ledger outlives a deleted order (as gift_card_transactions).
      order_id: { type: Sequelize.UUID, allowNull: true },
      payment_id: { type: Sequelize.UUID, allowNull: true },
      note: { type: Sequelize.STRING(200), allowNull: true },
      actor_user_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('loyalty_transactions', ['customer_id', 'created_at'], { name: 'loyalty_tx_customer_idx' });
    await queryInterface.addIndex('loyalty_transactions', ['order_id'], { name: 'loyalty_tx_order_idx' });
    // An order earns once.
    await queryInterface.addIndex('loyalty_transactions', ['order_id'], { name: 'loyalty_tx_earn_once', unique: true, where: { kind: 'earn' } });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('loyalty_transactions');
    await queryInterface.removeColumn('customers', 'loyalty_activity_at');
    await queryInterface.removeColumn('customers', 'loyalty_points');
  },
};
