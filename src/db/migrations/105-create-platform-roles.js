'use strict';

/**
 * Platform-console roles and per-account permissions, replacing the single
 * users.platform_admin flag as the thing access is checked against.
 *
 * platform_roles: one row per role. A role is data, not a schema enum: it is
 * a key, a display name and the default permission set copied onto an account
 * when the role is assigned. A new role is an INSERT here, nothing more.
 *
 * users.platform_role / users.platform_permissions: the account's role (NULL
 * = no console access) and the permission keys it actually holds. The set
 * starts as the role's default and a creator may edit it afterwards; checks
 * only ever look at the set (see core/security/platformPermissions.js).
 *
 * Three roles are seeded:
 *
 *   creator  '*' — everything, including managing other platform users.
 *   admin    everything except admins.manage (and the agent-only key).
 *   agent    referrals.view_own — their own codes and ledger, read-only.
 *
 * Every existing platform admin becomes `admin`, except Ziad's account, which
 * becomes the first `creator`. If that account is not an admin in some
 * database, nobody is made creator here; scripts/set-platform-role.js does it
 * out-of-band, as scripts/grant-platform-admin.js used to for the flag.
 *
 * The permission lists are written out literally rather than read from
 * platformPermissions.js, so that this migration keeps doing what it did when
 * it was written even after that file grows.
 *
 * users.platform_admin is left in place, no longer read or written by the
 * app: an instance still running the previous release during the deploy keeps
 * working against it. A later migration drops it. `down` rebuilds it from the
 * role (creator/admin = true; agents never had the flag).
 */

const CREATOR_EMAIL = 'ziadabbas27@gmail.com';

const ADMIN_PERMISSIONS = [
  'overview.view',
  'workspaces.view',
  'subscriptions.view',
  'subscriptions.manage',
  'plans.view',
  'plans.manage',
  'templates.view',
  'templates.manage',
  'risk.view',
  'risk.manage',
  'providers.view',
  'system.view',
  'feature_flags.view',
  'feature_flags.manage',
  'announcements.view',
  'announcements.manage',
  'support.view',
  'support.manage',
  'audit_log.view',
  'admins.view',
  'agents.view',
  'agents.manage',
  'commissions.mark_paid',
];

const ROLES = [
  {
    key: 'creator',
    name: 'Creator',
    description: 'Full access, including creating platform users and assigning any role.',
    permissions: ['*'],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Full access to the console except managing other platform users and their roles.',
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: 'agent',
    name: 'Agent',
    description: 'Read-only access to their own referral codes, referred merchants and commissions.',
    permissions: ['referrals.view_own'],
  },
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'platform_roles',
        {
          key: { type: DataTypes.STRING(64), primaryKey: true, allowNull: false },
          name: { type: DataTypes.STRING(100), allowNull: false },
          description: { type: DataTypes.TEXT, allowNull: true },
          default_permissions: { type: DataTypes.ARRAY(DataTypes.STRING(64)), allowNull: false, defaultValue: [] },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE platform_roles
           ADD CONSTRAINT platform_roles_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$')`,
        { transaction }
      );
      for (const role of ROLES) {
        await queryInterface.sequelize.query(
          `INSERT INTO platform_roles (key, name, description, default_permissions)
           VALUES (:key, :name, :description, ARRAY[:permissions]::varchar(64)[])`,
          { replacements: role, transaction }
        );
      }

      await queryInterface.addColumn(
        'users',
        'platform_role',
        {
          type: DataTypes.STRING(64),
          allowNull: true,
          references: { model: 'platform_roles', key: 'key' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'users',
        'platform_permissions',
        { type: DataTypes.ARRAY(DataTypes.STRING(64)), allowNull: false, defaultValue: [] },
        { transaction }
      );

      await queryInterface.sequelize.query(
        `UPDATE users
            SET platform_role = 'admin',
                platform_permissions = ARRAY[:permissions]::varchar(64)[]
          WHERE platform_admin = true`,
        { replacements: { permissions: ADMIN_PERMISSIONS }, transaction }
      );
      // users.email is CITEXT, so this ignores case.
      await queryInterface.sequelize.query(
        `UPDATE users
            SET platform_role = 'creator',
                platform_permissions = ARRAY['*']::varchar(64)[]
          WHERE platform_admin = true AND email = :email`,
        { replacements: { email: CREATOR_EMAIL }, transaction }
      );

      // No permissions without a role: revoking a role has to clear the set.
      await queryInterface.sequelize.query(
        `ALTER TABLE users
           ADD CONSTRAINT users_platform_permissions_need_role_check
           CHECK (platform_role IS NOT NULL OR cardinality(platform_permissions) = 0)`,
        { transaction }
      );
      await queryInterface.addIndex('users', ['platform_role'], {
        name: 'users_platform_role_idx',
        where: { platform_role: { [Sequelize.Op.ne]: null } },
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `UPDATE users SET platform_admin = COALESCE(platform_role IN ('creator', 'admin'), false)`,
        { transaction }
      );
      await queryInterface.removeIndex('users', 'users_platform_role_idx', { transaction });
      await queryInterface.sequelize.query(
        'ALTER TABLE users DROP CONSTRAINT users_platform_permissions_need_role_check',
        { transaction }
      );
      await queryInterface.removeColumn('users', 'platform_permissions', { transaction });
      await queryInterface.removeColumn('users', 'platform_role', { transaction });
      await queryInterface.dropTable('platform_roles', { transaction });
    });
  },
};
