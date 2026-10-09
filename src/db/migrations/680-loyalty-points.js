'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Loyalty points (modules/loyalty, STORE_FEATURES loyalty).
 * - customers.loyalty_points: the balance; loyalty_activity_at: the last
 *   earn or spend, from which inactive balances expire.
 * - loyalty_transactions: every change — earn, redeem, refund, reverse,
 *   expire, adjust (VARCHAR + CHECK). `amount` is the money a redeem stands
 *   for (minor units).
 * Additive and run-twice safe: customers gets a column with a constant
 * default and a nullable one (no rewrite).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('customers', 'loyalty_points', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await qi.addColumn('customers', 'loyalty_activity_at', { type: Sequelize.DATE, allowNull: true });
    const created = await qi.createTable('loyalty_transactions', {
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
    if (created) {
      await queryInterface.sequelize.query("ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_kind_check CHECK (kind IN ('earn', 'redeem', 'refund', 'reverse', 'expire', 'adjust'))");
    }
    await qi.addIndex('loyalty_transactions', ['customer_id', 'created_at'], { name: 'loyalty_tx_customer_idx' });
    await qi.addIndex('loyalty_transactions', ['order_id'], { name: 'loyalty_tx_order_idx' });
    // An order earns once.
    await qi.addIndex('loyalty_transactions', ['order_id'], { name: 'loyalty_tx_earn_once', unique: true, where: { kind: 'earn' } });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.dropTable('loyalty_transactions');
    await qi.removeColumn('customers', 'loyalty_activity_at');
    await qi.removeColumn('customers', 'loyalty_points');
  },
};
