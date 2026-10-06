'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's specification key, e.g. "Material" (migration 494, modules/productSpecs).
  const SpecKey = sequelize.define(
    'SpecKey',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.JSONB, allowNull: false },
      unit: { type: DataTypes.STRING(20), allowNull: true },
      filterable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'spec_keys' }
  );
  return SpecKey;
};
