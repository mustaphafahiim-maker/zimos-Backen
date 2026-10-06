'use strict';

/**
 * Push notifications to shoppers about their order (SPEC §20.2: the store's
 * PWA "home-screen icon, push notifications"). A shopper who asks for updates
 * on the thank-you page subscribes that browser to that one order; the store
 * then pushes its confirmation, shipping and delivery. Rows go with the order.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('order_push_subscriptions', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      order_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      // web for now; the browser's push subscription (JSON), or a sandbox token.
      platform: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'web' },
      token: { type: DataTypes.TEXT, allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false },
      last_sent_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('order_push_subscriptions', ['order_id', 'token_hash'], { unique: true, name: 'order_push_subscriptions_order_token_uniq' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('order_push_subscriptions');
  },
};
