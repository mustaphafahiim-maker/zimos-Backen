'use strict';

module.exports = (sequelize, DataTypes) => {
  // A governorate / region or a city of the platform's place list (migration 403, modules/geo).
  const GeoRegion = sequelize.define(
    'GeoRegion',
    {
      code: { type: DataTypes.STRING(80), primaryKey: true },
      country: { type: DataTypes.STRING(2), allowNull: false },
      level: { type: DataTypes.STRING(20), allowNull: false },
      parentCode: { type: DataTypes.STRING(80), allowNull: true, field: 'parent_code' },
      nameAr: { type: DataTypes.STRING(120), allowNull: false, field: 'name_ar' },
      nameEn: { type: DataTypes.STRING(120), allowNull: false, field: 'name_en' },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
    },
    { tableName: 'geo_regions' }
  );
  return GeoRegion;
};
