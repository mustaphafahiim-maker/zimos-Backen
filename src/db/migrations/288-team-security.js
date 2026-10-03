'use strict';

/**
 * Team and account security (SPEC §17.1–17.2).
 *
 * roles                  every existing store gets the new system role
 *                        `fulfillment` (shipping and printing only).
 * user_two_factor        a person's two-step sign-in: off, a code by email on
 *                        a new device, or an authenticator app (TOTP). The
 *                        secret is sealed (core/utils/secretBox).
 * login_challenges       a sign-in waiting for its second step.
 * trusted_devices        browsers that passed the second step and asked to be
 *                        remembered (only a hash of the device cookie).
 * support_access_grants  the merchant letting ZIMOS support into the store
 *                        for a set time.
 */

const FULFILLMENT = ['orders.view', 'shipping.manage', 'inventory.view', 'products.view'];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('NOW()');
    const id = { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') };
    const stamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    };
    const user = { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' };

    await queryInterface.sequelize.query(
      `INSERT INTO roles (id, workspace_id, key, name, is_system, permissions, created_at, updated_at)
       SELECT gen_random_uuid(), w.id, 'fulfillment', 'Fulfillment', true, ARRAY[:permissions]::varchar[], NOW(), NOW()
         FROM workspaces w
        WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.workspace_id = w.id AND r.key = 'fulfillment')`,
      { replacements: { permissions: FULFILLMENT } }
    );

    await queryInterface.createTable('user_two_factor', {
      user_id: { ...user, primaryKey: true },
      mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'off' }, // off | email | totp
      totp_secret_sealed: { type: DataTypes.TEXT, allowNull: true },
      // A secret being set up: becomes totp_secret_sealed once a code confirms it.
      pending_secret_sealed: { type: DataTypes.TEXT, allowNull: true },
      enabled_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps,
    });

    await queryInterface.createTable('login_challenges', {
      id,
      user_id: user,
      channel: { type: DataTypes.STRING(10), allowNull: false }, // email | totp
      code_hash: { type: DataTypes.STRING(64), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      ip_address: { type: DataTypes.STRING(64), allowNull: true },
      ...stamps,
    });
    await queryInterface.addIndex('login_challenges', ['user_id', 'created_at'], { name: 'login_challenges_user_idx' });

    await queryInterface.createTable('trusted_devices', {
      id,
      user_id: user,
      device_hash: { type: DataTypes.STRING(64), allowNull: false },
      user_agent: { type: DataTypes.STRING(500), allowNull: true },
      last_used_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      ...stamps,
    });
    await queryInterface.addIndex('trusted_devices', ['user_id', 'device_hash'], { unique: true, name: 'trusted_devices_uq' });

    await queryInterface.createTable('support_access_grants', {
      id,
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      granted_by_user_id: { type: DataTypes.UUID, allowNull: true },
      note: { type: DataTypes.STRING(300), allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      revoked_by_user_id: { type: DataTypes.UUID, allowNull: true },
      last_used_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps,
    });
    await queryInterface.addIndex('support_access_grants', ['workspace_id', 'expires_at'], { name: 'support_access_grants_ws_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('support_access_grants');
    await queryInterface.dropTable('trusted_devices');
    await queryInterface.dropTable('login_challenges');
    await queryInterface.dropTable('user_two_factor');
    // Only where nobody holds the role: a membership must keep pointing at a role.
    await queryInterface.sequelize.query(
      `DELETE FROM roles r WHERE r.key = 'fulfillment' AND r.is_system
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.role_id = r.id)`
    );
  },
};
