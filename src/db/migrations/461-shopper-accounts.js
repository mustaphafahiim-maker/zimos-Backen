'use strict';

/**
 * Shopper accounts (modules/shopperAccounts, spec-gaps item 185): a shopper
 * signs in to a store with a code sent to their phone or email.
 *
 * - shopper_login_codes: one row per code sent; only an HMAC of the code is
 *   kept; also what the send limits count.
 * - customers.saved_addresses: the shopper's own addresses (at most 10).
 * - customers.account_version: in every sign-in token; "sign out
 *   everywhere" raises it.
 * - customers.last_login_at.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('shopper_login_codes', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      channel: { type: Sequelize.STRING(10), allowNull: false },
      target: { type: Sequelize.STRING(255), allowNull: false },
      customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      code_hash: { type: Sequelize.STRING(64), allowNull: false },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      consumed_at: { type: Sequelize.DATE, allowNull: true },
      superseded_at: { type: Sequelize.DATE, allowNull: true },
      request_ip: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('shopper_login_codes', ['workspace_id', 'target', 'created_at'], { name: 'shopper_login_codes_target_idx' });
    await queryInterface.addIndex('shopper_login_codes', ['request_ip', 'created_at'], { name: 'shopper_login_codes_ip_idx' });
    await queryInterface.addColumn('customers', 'saved_addresses', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addColumn('customers', 'account_version', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });
    await queryInterface.addColumn('customers', 'last_login_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('customers', 'last_login_at');
    await queryInterface.removeColumn('customers', 'account_version');
    await queryInterface.removeColumn('customers', 'saved_addresses');
    await queryInterface.dropTable('shopper_login_codes');
  },
};
