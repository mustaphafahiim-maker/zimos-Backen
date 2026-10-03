'use strict';

/**
 * Saved payment methods (SPEC §11.6): the gateway's token for a customer's
 * card, kept so a one-click upsell or a renewal can charge it again. Only the
 * gateway's opaque token is stored, sealed; never a card number.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    await queryInterface.createTable('payment_methods_saved', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      customer_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      provider_code: { type: DataTypes.STRING(50), allowNull: false },
      token_sealed: { type: DataTypes.TEXT, allowNull: false },
      brand: { type: DataTypes.STRING(30), allowNull: true },
      last4: { type: DataTypes.STRING(4), allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      source_payment_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'payments', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      last_used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('payment_methods_saved', ['workspace_id', 'customer_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('payment_methods_saved');
  },
};
