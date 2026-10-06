'use strict';

module.exports = (sequelize, DataTypes) => {
  // A product import and its report — see migration 187 and catalog/importExport.
  const CatalogImport = sequelize.define(
    'CatalogImport',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // 'json' | 'sheet' | 'shopify_link'
      kind: { type: DataTypes.STRING(16), allowNull: false },
      // 'queued' | 'running' | 'done' | 'failed'
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
      sourceName: { type: DataTypes.STRING(300), allowNull: true, field: 'source_name' },
      // The parsed products, emptied once the job has run.
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      createdCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'created_count' },
      failedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'failed_count' },
      // [{ row, name, message }]
      errors: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      // [{ row, productId, name, sourceCurrency, reviewsImported }] — the products it created.
      results: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    },
    { tableName: 'catalog_imports', indexes: [{ fields: ['workspace_id', 'created_at'] }] }
  );

  CatalogImport.associate = (models) => {
    CatalogImport.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };

  return CatalogImport;
};
