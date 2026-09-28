'use strict';

/**
 * Manual store suspension by a platform admin.
 *
 * It uses the existing workspaces.status value 'suspended', which nothing set
 * until now (public store routes already treated it as not live). A
 * suspension is independent of billing: it lives on the workspace, not the
 * subscription, so paying never lifts it and reactivating never touches the
 * subscription. This adds who suspended it, when and why:
 *
 *   suspended_at, suspended_by_user_id, suspension_reason
 *
 * set together while suspended and cleared on reactivation (the audit log
 * keeps the history).
 *
 * And a platform permission, `workspaces.manage` (suspend / reactivate). It is
 * added to the admin role's default set, and to admin accounts that still hold
 * the whole of that set — an admin a creator narrowed does not gain it
 * silently.
 */

const KEY = 'workspaces.manage';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('workspaces', 'suspended_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn(
        'workspaces',
        'suspended_by_user_id',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        { transaction }
      );
      await queryInterface.addColumn('workspaces', 'suspension_reason', { type: DataTypes.TEXT, allowNull: true }, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE workspaces
           ADD CONSTRAINT workspaces_suspension_check
           CHECK ((status = 'suspended') = (suspended_at IS NOT NULL AND suspension_reason IS NOT NULL))`,
        { transaction }
      );

      // Standard admins (holding the whole admin default set) gain the key,
      // then the role's default set does.
      await queryInterface.sequelize.query(
        `UPDATE users u
            SET platform_permissions = array_append(u.platform_permissions, CAST(:key AS varchar(64)))
           FROM platform_roles r
          WHERE r.key = 'admin'
            AND u.platform_role = 'admin'
            AND u.platform_permissions @> r.default_permissions
            AND NOT (:key = ANY (u.platform_permissions))`,
        { replacements: { key: KEY }, transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE platform_roles
            SET default_permissions = array_append(default_permissions, CAST(:key AS varchar(64))),
                updated_at = NOW()
          WHERE key = 'admin' AND NOT (:key = ANY (default_permissions))`,
        { replacements: { key: KEY }, transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'UPDATE users SET platform_permissions = array_remove(platform_permissions, CAST(:key AS varchar(64)))',
        { replacements: { key: KEY }, transaction }
      );
      await queryInterface.sequelize.query(
        'UPDATE platform_roles SET default_permissions = array_remove(default_permissions, CAST(:key AS varchar(64)))',
        { replacements: { key: KEY }, transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE workspaces DROP CONSTRAINT workspaces_suspension_check', {
        transaction,
      });
      await queryInterface.removeColumn('workspaces', 'suspension_reason', { transaction });
      await queryInterface.removeColumn('workspaces', 'suspended_by_user_id', { transaction });
      await queryInterface.removeColumn('workspaces', 'suspended_at', { transaction });
    });
  },
};
