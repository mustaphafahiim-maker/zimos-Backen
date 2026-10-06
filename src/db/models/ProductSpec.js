'use strict';

module.exports = (sequelize, DataTypes) => {
  // A product's value for a specification key (migration 494, modules/productSpecs).
  const ProductSpec = sequelize.define(
    'ProductSpec',
    {
      productId: { type: DataTypes.UUID, primaryKey: true, field: 'product_id' },
      specKeyId: { type: DataTypes.UUID, primaryKey: true, field: 'spec_key_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      value: { type: DataTypes.STRING(200), allowNull: false },
    },
    { tableName: 'product_specs' }
  );
  return ProductSpec;
};
