'use strict';

/**
 * Domains bought from the dashboard (modules/domains/purchases.js): which
 * registrar holds it, until when, whether it renews itself, and the price the
 * registrar quoted when it was bought (minor units; never set in our code).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('domain_purchases', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      domain_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'domains', key: 'id' }, onDelete: 'SET NULL' },
      hostname: { type: Sequelize.STRING(255), allowNull: false },
      registrar: { type: Sequelize.STRING(40), allowNull: false },
      provider_ref: { type: Sequelize.STRING(120), allowNull: true },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
      years: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      price_amount: { type: Sequelize.BIGINT, allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: true },
      auto_renew: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      last_renewed_at: { type: Sequelize.DATE, allowNull: true },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('domain_purchases', ['hostname'], { unique: true, name: 'domain_purchases_hostname_idx' });
    await queryInterface.addIndex('domain_purchases', ['workspace_id'], { name: 'domain_purchases_workspace_idx' });
    await queryInterface.addIndex('domain_purchases', ['status', 'expires_at'], { name: 'domain_purchases_renew_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('domain_purchases');
  },
};
