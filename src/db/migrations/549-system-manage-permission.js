'use strict';

/**
 * A platform permission, `system.manage`: acting on the system rather than
 * looking at it — for now, retrying a failed queue job
 * (POST /admin/system/queues/jobs/:jobId/retry), which until now needed only
 * system.view.
 *
 * As migrations 111 and 413 did: it is added to the admin role's default set,
 * and to admin accounts that still hold the whole of that set — an admin a
 * creator narrowed does not gain it silently. Creators hold it through '*'.
 */

const KEY = 'system.manage';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
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
      await queryInterface.sequelize.query('UPDATE users SET platform_permissions = array_remove(platform_permissions, CAST(:key AS varchar(64)))', {
        replacements: { key: KEY },
        transaction,
      });
      await queryInterface.sequelize.query('UPDATE platform_roles SET default_permissions = array_remove(default_permissions, CAST(:key AS varchar(64)))', {
        replacements: { key: KEY },
        transaction,
      });
    });
  },
};
