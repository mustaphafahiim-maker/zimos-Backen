'use strict';

/** B2B quote requests (modules/quotes, spec-gaps item 219). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('quote_requests', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      number: { type: Sequelize.STRING(20), allowNull: false },
      customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL' },
      // { fullName, phone, email, company }
      contact: { type: Sequelize.JSONB, allowNull: false },
      // [{ variantId, quantity, note }]
      lines: { type: Sequelize.JSONB, allowNull: false },
      message: { type: Sequelize.TEXT, allowNull: true },
      // new | quoted | accepted | declined | cancelled
      status: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'new' },
      // [{ variantId, quantity, unitPrice }] — the store's offer
      quoted_lines: { type: Sequelize.JSONB, allowNull: true },
      quoted_note: { type: Sequelize.TEXT, allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: true },
      valid_until: { type: Sequelize.DATE, allowNull: true },
      quoted_at: { type: Sequelize.DATE, allowNull: true },
      quoted_by: { type: Sequelize.UUID, allowNull: true },
      order_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'orders', key: 'id' }, onDelete: 'SET NULL' },
      // The shopper's access to their quote (only the hash is kept).
      token_hash: { type: Sequelize.STRING(64), allowNull: false },
      request_ip: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('quote_requests', ['workspace_id', 'number'], { name: 'quote_requests_number_uq', unique: true });
    await queryInterface.addIndex('quote_requests', ['workspace_id', 'status', 'created_at'], { name: 'quote_requests_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('quote_requests');
  },
};
