'use strict';

module.exports = (sequelize, DataTypes) => {
  // One teammate's notification choices in one store. `channels` holds only
  // what differs from the defaults in merchantNotificationService.js:
  // { "<type>": { "inApp": bool, "email": bool } }.
  const NotificationPreference = sequelize.define(
    'NotificationPreference',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      soundEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'sound_enabled' },
    },
    { tableName: 'notification_preferences', indexes: [{ unique: true, fields: ['workspace_id', 'user_id'] }] }
  );
  NotificationPreference.associate = (models) => {
    NotificationPreference.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    NotificationPreference.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };
  return NotificationPreference;
};
