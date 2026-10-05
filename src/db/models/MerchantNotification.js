'use strict';

module.exports = (sequelize, DataTypes) => {
  // The dashboard bell (modules/notifications/merchantNotificationService.js).
  // Not to be confused with NotificationLog, which records outbound
  // email/SMS/WhatsApp sends.
  const MerchantNotification = sequelize.define(
    'MerchantNotification',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // Null = shown to the whole team (one shared read state).
      userId: { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
      type: { type: DataTypes.STRING(50), allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: true },
      // A dashboard path (`/orders/<id>`), never an absolute URL.
      link: { type: DataTypes.STRING(500), allowNull: true },
      // The values the title/body were built from, so the dashboard can
      // render the notification in the viewer's language.
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      dedupeKey: { type: DataTypes.STRING(200), allowNull: true, field: 'dedupe_key' },
      readAt: { type: DataTypes.DATE, allowNull: true, field: 'read_at' },
    },
    { tableName: 'notifications' }
  );
  MerchantNotification.associate = (models) => {
    MerchantNotification.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    MerchantNotification.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };
  return MerchantNotification;
};
