'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Which place on a courier's own address list a geo region is (SPEC §12.2
 * "city mapping"): the courier city and district ids an order from that
 * region is booked to (`carrier_path` holds every level's id, top first, for
 * couriers with other levels).
 *
 *   workspace_id NULL   found by name matching (source 'auto'); the same
 *                       for every store, since a courier's list is the same
 *   workspace_id set    the store's own choice (source 'manual'), which wins
 *
 * Used by shipping/carrierRegionMap.js when an order is booked, and edited
 * from the courier's "Areas" screen.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('carrier_region_map', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      carrier_code: { type: DataTypes.STRING(100), allowNull: false },
      geo_region_code: { type: DataTypes.STRING(80), allowNull: false, references: { model: 'geo_regions', key: 'code' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      carrier_city_id: { type: DataTypes.STRING(100), allowNull: false },
      carrier_district_id: { type: DataTypes.STRING(100), allowNull: true },
      carrier_path: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      // The courier's names along the path, for the screen: [{ id, name, nameAr }].
      carrier_names: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      // auto | manual
      source: { type: DataTypes.STRING(10), allowNull: false },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS carrier_region_map_shared_uniq ON carrier_region_map (carrier_code, geo_region_code) WHERE workspace_id IS NULL');
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS carrier_region_map_store_uniq ON carrier_region_map (workspace_id, carrier_code, geo_region_code) WHERE workspace_id IS NOT NULL');
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('carrier_region_map');
  },
};
