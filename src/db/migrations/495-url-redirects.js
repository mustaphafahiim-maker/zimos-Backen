'use strict';

/** Storefront URL redirects (modules/urlRedirects, spec-gaps item 232). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('url_redirects', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      from_path: { type: Sequelize.STRING(500), allowNull: false },
      to_path: { type: Sequelize.STRING(1000), allowNull: false },
      status_code: { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 301 },
      // manual | auto (a slug changed) | import
      source: { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'manual' },
      hits: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_hit_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('url_redirects', ['workspace_id', 'from_path'], { name: 'url_redirects_from_uq', unique: true });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('url_redirects');
  },
};
