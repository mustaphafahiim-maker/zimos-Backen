'use strict';

module.exports = (sequelize, DataTypes) => {
  // A reusable quantity bundle — see migration 189 and modules/bundles.
  const Bundle = sequelize.define(
    'Bundle',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      // 'cards' | 'radio' | 'dropdown'
      displayStyle: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'cards', field: 'display_style' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'bundles', indexes: [{ fields: ['workspace_id'] }] }
  );

  Bundle.associate = (models) => {
    Bundle.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Bundle.hasMany(models.BundleTier, { foreignKey: 'bundleId', as: 'tiers' });
    Bundle.hasMany(models.Product, { foreignKey: 'bundleId', as: 'products' });
  };

  return Bundle;
};
