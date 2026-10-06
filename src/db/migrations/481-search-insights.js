'use strict';

/**
 * Storefront search analytics (modules/searchInsights, spec-gaps item 211):
 * what shoppers search (first page of results only), how many results, and
 * which result they opened. Kept 180 days.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('search_queries', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      query: { type: Sequelize.STRING(200), allowNull: false },
      results_count: { type: Sequelize.INTEGER, allowNull: false },
      // The synonym searched instead, when the query itself found nothing.
      served_as: { type: Sequelize.STRING(200), allowNull: true },
      visitor_id: { type: Sequelize.STRING(64), allowNull: true },
      clicked_product_id: { type: Sequelize.UUID, allowNull: true },
      clicked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('search_queries', ['workspace_id', 'created_at'], { name: 'search_queries_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('search_queries');
  },
};
