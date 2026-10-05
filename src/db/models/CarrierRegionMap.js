'use strict';

module.exports = (sequelize, DataTypes) => {
  // Where a geo region is on a courier's address list (migration 182, shipping/carrierRegionMap.js).
  // workspaceId null: found by name matching, shared; set: the store's own choice.
  const CarrierRegionMap = sequelize.define(
    'CarrierRegionMap',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      carrierCode: { type: DataTypes.STRING(100), allowNull: false, field: 'carrier_code' },
      geoRegionCode: { type: DataTypes.STRING(80), allowNull: false, field: 'geo_region_code' },
      carrierCityId: { type: DataTypes.STRING(100), allowNull: false, field: 'carrier_city_id' },
      carrierDistrictId: { type: DataTypes.STRING(100), allowNull: true, field: 'carrier_district_id' },
      carrierPath: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'carrier_path' },
      carrierNames: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'carrier_names' },
      source: { type: DataTypes.STRING(10), allowNull: false },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'carrier_region_map' }
  );
  return CarrierRegionMap;
};
