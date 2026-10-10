'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Shopper accounts (modules/shopperAccounts, STORE_FEATURES shopper_accounts):
 * a shopper signs in to a store with a code sent to their phone or email.
 *
 * - shopper_login_codes: one row per code sent; only an HMAC of the code is
 *   kept; also what the send limits count. channel: sms | email | email_link
 *   (a signed-in shopper verifying an email), VARCHAR + CHECK.
 * - customers.saved_addresses: the shopper's own addresses (at most 10).
 * - customers.account_version: in every sign-in token; "sign out
 *   everywhere" raises it.
 * - customers.last_login_at.
 *
 * Additive and run-twice safe; the customers columns are nullable or carry a
 * constant default (no rewrite).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const created = await qi.createTable('shopper_login_codes', {
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
    if (created) await queryInterface.sequelize.query("ALTER TABLE shopper_login_codes ADD CONSTRAINT shopper_login_codes_channel_check CHECK (channel IN ('sms', 'email', 'email_link'))");
    await qi.addIndex('shopper_login_codes', ['workspace_id', 'target', 'created_at'], { name: 'shopper_login_codes_target_idx' });
    await qi.addIndex('shopper_login_codes', ['request_ip', 'created_at'], { name: 'shopper_login_codes_ip_idx' });
    await qi.addColumn('customers', 'saved_addresses', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await qi.addColumn('customers', 'account_version', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });
    await qi.addColumn('customers', 'last_login_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('customers', 'last_login_at');
    await qi.removeColumn('customers', 'account_version');
    await qi.removeColumn('customers', 'saved_addresses');
    await queryInterface.dropTable('shopper_login_codes');
  },
};
