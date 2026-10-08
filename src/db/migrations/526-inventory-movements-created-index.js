'use strict';

/**
 * The store-wide stock movement list and its export (inventory/movementHistory.js,
 * spec-gaps item 389) read a store's newest movements first:
 * WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT n, paged by
 * (created_at, id). No index served that order, so every page sorted all of
 * the store's movements. This one reads the page straight off the index.
 */
const NAME = 'inventory_movements_workspace_created_idx';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS ${NAME} ON inventory_movements (workspace_id, created_at DESC, id DESC)`
    );
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${NAME}`);
  },
};
