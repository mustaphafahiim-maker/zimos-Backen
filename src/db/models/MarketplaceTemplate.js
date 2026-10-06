'use strict';

module.exports = (sequelize, DataTypes) => {
  // A funnel template a merchant submitted to the marketplace (migration 466, modules/marketplace).
  const MarketplaceTemplate = sequelize.define(
    'MarketplaceTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.STRING(1000), allowNull: true },
      category: { type: DataTypes.STRING(40), allowNull: false },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(40)), allowNull: false, defaultValue: [] },
      thumbnailUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'thumbnail_url' },
      authorName: { type: DataTypes.STRING(120), allowNull: false, field: 'author_name' },
      language: { type: DataTypes.STRING(5), allowNull: true },
      snapshot: { type: DataTypes.JSONB, allowNull: false },
      stepCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'step_count' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      reviewNote: { type: DataTypes.STRING(1000), allowNull: true, field: 'review_note' },
      reviewedBy: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by' },
      reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
      usesCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'uses_count' },
      submittedBy: { type: DataTypes.UUID, allowNull: true, field: 'submitted_by' },
    },
    { tableName: 'marketplace_templates' }
  );
  return MarketplaceTemplate;
};
