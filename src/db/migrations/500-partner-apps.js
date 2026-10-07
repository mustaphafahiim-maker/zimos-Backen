'use strict';

/**
 * Partner apps with OAuth (modules/partnerApps, spec-gaps item 265, SPEC §16.3):
 * an app a developer registers (client id / secret, redirect addresses, the
 * scopes it may ask for, the page shown inside the dashboard), and the
 * one-time codes of the authorization-code flow. An installation is a
 * workspace_apps row (kind external) holding an api_keys row as its token.
 * First migration of the 500–549 range (owner, 2026-10-07, LANES).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('partner_apps', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      owner_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(80), allowNull: false },
      description: { type: Sequelize.STRING(500), allowNull: true },
      icon_url: { type: Sequelize.STRING(500), allowNull: true },
      // The page the dashboard shows inside the app's frame (https).
      app_url: { type: Sequelize.STRING(500), allowNull: true },
      redirect_uris: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      scopes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      client_id: { type: Sequelize.STRING(40), allowNull: false, unique: true },
      // Sealed (core/utils/secretBox): checked on the token exchange and used to sign the frame's address.
      client_secret_sealed: { type: Sequelize.TEXT, allowNull: false },
      // development (only the developer's own stores) | published | suspended
      status: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'development' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('partner_apps', ['owner_user_id'], { name: 'partner_apps_owner_idx' });

    await queryInterface.createTable('oauth_codes', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      code_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      partner_app_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'partner_apps', key: 'id' }, onDelete: 'CASCADE' },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      scopes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      redirect_uri: { type: Sequelize.STRING(500), allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      used_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('oauth_codes');
    await queryInterface.dropTable('partner_apps');
  },
};
