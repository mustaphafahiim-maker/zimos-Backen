'use strict';

module.exports = (sequelize, DataTypes) => {
  // A region, city or area of a store's own place list (migration 451, modules/places).
  const StorePlace = sequelize.define(
    'StorePlace',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      country: { type: DataTypes.STRING(2), allowNull: false },
      // 'region' | 'city' | 'area'
      level: { type: DataTypes.STRING(10), allowNull: false },
      parentId: { type: DataTypes.UUID, allowNull: true, field: 'parent_id' },
      nameAr: { type: DataTypes.STRING(120), allowNull: false, field: 'name_ar' },
      nameEn: { type: DataTypes.STRING(120), allowNull: false, field: 'name_en' },
      // The platform place (geo_regions.code) it stands for, when known.
      geoCode: { type: DataTypes.STRING(80), allowNull: true, field: 'geo_code' },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
      hidden: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'store_places' }
  );
  return StorePlace;
};
