'use strict';

module.exports = (sequelize, DataTypes) => {
  // A theme a store has used or owns (migration 191): source free | purchase.
  const WorkspaceTheme = sequelize.define(
    'WorkspaceTheme',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      themeKey: { type: DataTypes.STRING(40), allowNull: false, field: 'theme_key' },
      source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'free' },
    },
    { tableName: 'workspace_themes' }
  );
  return WorkspaceTheme;
};
