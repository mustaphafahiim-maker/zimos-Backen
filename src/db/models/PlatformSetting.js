'use strict';

module.exports = (sequelize, DataTypes) => {
  // A platform-wide setting decided by ZIMOS, not written in code (migration 415).
  const PlatformSetting = sequelize.define(
    'PlatformSetting',
    {
      key: { type: DataTypes.STRING(100), primaryKey: true },
      value: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'platform_settings' }
  );
  return PlatformSetting;
};
