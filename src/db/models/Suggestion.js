'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant's suggestion to the platform, answered from the console (migration 219, modules/suggestions).
  const Suggestion = sequelize.define(
    'Suggestion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
      title: { type: DataTypes.STRING(150), allowNull: false },
      description: { type: DataTypes.STRING(4000), allowNull: false },
      category: { type: DataTypes.STRING(20), allowNull: false },
      contact: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new' },
      adminReply: { type: DataTypes.STRING(4000), allowNull: true, field: 'admin_reply' },
      repliedAt: { type: DataTypes.DATE, allowNull: true, field: 'replied_at' },
      repliedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'replied_by_user_id' },
    },
    { tableName: 'suggestions' }
  );
  Suggestion.associate = (models) => {
    Suggestion.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Suggestion.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };
  return Suggestion;
};
