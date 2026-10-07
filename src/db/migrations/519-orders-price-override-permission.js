'use strict';

/**
 * The store permission `orders.price_override` (item 382): changing prices on
 * an order (a line's price, a custom line, a manual discount). Owner has it
 * through '*'. It is added to every store's system Workspace Manager role, as
 * core/security/permissions.js now seeds it — when that role can still manage
 * orders (a role a store narrowed does not gain it silently). Custom roles and
 * the other system roles do not gain it either: the owner gives it from the
 * team settings.
 */

const KEY = 'orders.price_override';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `UPDATE roles
          SET permissions = array_append(permissions, CAST(:key AS varchar(255))), updated_at = NOW()
        WHERE key = 'workspace_manager' AND is_system = true
          AND 'orders.manage' = ANY (permissions) AND NOT (:key = ANY (permissions))`,
      { replacements: { key: KEY } }
    );
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('UPDATE roles SET permissions = array_remove(permissions, CAST(:key AS varchar(255))) WHERE :key = ANY (permissions)', {
      replacements: { key: KEY },
    });
  },
};
