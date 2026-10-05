'use strict';

module.exports = (sequelize, DataTypes) => {
  const Funnel = sequelize.define(
    'Funnel',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      subdomain: { type: DataTypes.STRING(100), allowNull: true, unique: true },
      status: { type: DataTypes.ENUM('draft', 'published', 'paused'), allowNull: false, defaultValue: 'draft' },
      publishedRevisionId: { type: DataTypes.UUID, allowNull: true, field: 'published_revision_id' },
      // Share code, and the map editor's auto-saved draft (funnels/funnelExtras.js).
      shareCode: { type: DataTypes.STRING(20), allowNull: true, unique: true, field: 'share_code' },
      draftData: { type: DataTypes.JSONB, allowNull: true, field: 'draft_data' },
      draftUpdatedAt: { type: DataTypes.DATE, allowNull: true, field: 'draft_updated_at' },
      // { currency, faviconUrl, title, description } — funnels/geoRedirects.js.
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    {
      tableName: 'funnels',
      indexes: [{ fields: ['workspace_id'] }],
      // The auto-saved draft can be large: it is read only by the draft
      // endpoints (Funnel.unscoped()), never with a funnel list or detail.
      defaultScope: { attributes: { exclude: ['draftData'] } },
    }
  );
  Funnel.associate = (models) => {
    Funnel.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Funnel.hasMany(models.FunnelStep, { foreignKey: 'funnelId', as: 'steps' });
    Funnel.hasMany(models.FunnelEdge, { foreignKey: 'funnelId', as: 'edges' });
    Funnel.hasMany(models.FunnelRevision, { foreignKey: 'funnelId', as: 'revisions' });
  };
  return Funnel;
};
