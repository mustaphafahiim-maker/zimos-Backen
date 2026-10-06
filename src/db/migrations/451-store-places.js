'use strict';

/**
 * A store's own places (modules/places/storePlaces.js): regions → cities →
 * areas per country, typed or imported from a sheet. `geo_code` links a
 * region or city to the platform's list (geo_regions) when its name is found
 * there, so the store's governorate prices and couriers' area maps still apply.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('store_places', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      country: { type: Sequelize.STRING(2), allowNull: false },
      level: { type: Sequelize.STRING(10), allowNull: false },
      parent_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'store_places', key: 'id' }, onDelete: 'CASCADE' },
      name_ar: { type: Sequelize.STRING(120), allowNull: false },
      name_en: { type: Sequelize.STRING(120), allowNull: false },
      geo_code: { type: Sequelize.STRING(80), allowNull: true },
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      hidden: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('store_places', ['workspace_id', 'country', 'level'], { name: 'store_places_ws_country_idx' });
    await queryInterface.addIndex('store_places', ['parent_id'], { name: 'store_places_parent_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('store_places');
  },
};
