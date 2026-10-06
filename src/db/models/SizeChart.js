'use strict';

module.exports = (sequelize, DataTypes) => {
  // A size table for products / collections (migration 480, modules/sizeCharts).
  const SizeChart = sequelize.define(
    'SizeChart',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      unit: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'cm' },
      columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      rows: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      note: { type: DataTypes.JSONB, allowNull: true },
      imageUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'image_url' },
      productIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'product_ids' },
      collectionIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'collection_ids' },
    },
    { tableName: 'size_charts' }
  );
  return SizeChart;
};
