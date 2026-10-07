'use strict';

/**
 * A saved-card token a gateway sends on its own callback, before ZIMOS asks
 * for it (item 380). Paymob posts a TOKEN callback when the shopper ticks
 * "save card" on its checkout; the token is held here, sealed
 * (core/utils/secretBox.js), against the payment it came with, until
 * savedMethodService.saveFromPayment turns it into the customer's saved card
 * (then the row is deleted). Rows nobody saved are dropped after 30 days.
 *
 *   payment_id    the payment the card paid (one row per payment)
 *   token_sealed  never returned by any endpoint, never logged
 *   brand, last4, expires_at   what the gateway said about the card
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('gateway_card_tokens', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      payment_id: { type: Sequelize.UUID, allowNull: false, unique: true, references: { model: 'payments', key: 'id' }, onDelete: 'CASCADE' },
      provider_code: { type: Sequelize.STRING(50), allowNull: false },
      token_sealed: { type: Sequelize.TEXT, allowNull: false },
      brand: { type: Sequelize.STRING(30), allowNull: true },
      last4: { type: Sequelize.STRING(4), allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.addIndex('gateway_card_tokens', ['created_at']);
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('gateway_card_tokens');
  },
};
