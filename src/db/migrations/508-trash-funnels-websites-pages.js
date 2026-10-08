'use strict';

/**
 * A trash for funnels, websites and pages (item 373, Lightfunnels parity).
 *
 *   funnels / websites / website_pages
 *     deleted_at   set when the merchant deletes it: the row stays (with its
 *                  steps, edges, revisions, sessions, pages and domains) and
 *                  the models are paranoid, so every lookup skips it until it
 *                  is restored or purged (modules/trash)
 *     deleted_by   who moved it to the trash (SET NULL with the user)
 *
 *   orders.funnel_name
 *     the funnel's name, written when a trashed funnel is purged for good;
 *     orders.funnel_id is SET NULL then, and the order still shows the
 *     funnel it came through
 */
const TABLES = ['funnels', 'websites', 'website_pages'];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    for (const table of TABLES) {
      await queryInterface.addColumn(table, 'deleted_at', { type: Sequelize.DATE, allowNull: true });
      await queryInterface.addColumn(table, 'deleted_by', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex(table, ['workspace_id', 'deleted_at'], { name: `${table}_workspace_deleted_at` });
    }
    await queryInterface.addColumn('orders', 'funnel_name', { type: Sequelize.STRING(200), allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'funnel_name');
    for (const table of [...TABLES].reverse()) {
      await queryInterface.removeIndex(table, `${table}_workspace_deleted_at`);
      await queryInterface.removeColumn(table, 'deleted_by');
      await queryInterface.removeColumn(table, 'deleted_at');
    }
  },
};
