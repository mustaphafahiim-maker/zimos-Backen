'use strict';

module.exports = (sequelize, DataTypes) => {
  // A teammate's named filters for a list (migration 188, workspaces/savedViews.js).
  const SavedView = sequelize.define(
    'SavedView',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      scope: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      query: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'saved_views' }
  );
  return SavedView;
};
