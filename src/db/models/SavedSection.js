'use strict';

module.exports = (sequelize, DataTypes) => {
  // A page section saved for reuse; see modules/savedSections/savedSectionsService.js.
  const SavedSection = sequelize.define(
    'SavedSection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      scope: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'global' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      type: { type: DataTypes.STRING(40), allowNull: true },
      tree: { type: DataTypes.JSONB, allowNull: false },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'saved_sections', indexes: [{ fields: ['workspace_id', 'scope'] }] }
  );
  return SavedSection;
};
