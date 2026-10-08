'use strict';

module.exports = (sequelize, DataTypes) => {
  // A Telegram group, Slack or Discord channel that gets the store's alerts
  // (item 378, migration 512, modules/notifications/teamChannels).
  const TeamChannel = sequelize.define(
    'TeamChannel',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // telegram | slack | discord
      provider: { type: DataTypes.STRING(20), allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      // Sealed with core/utils/secretBox; never serialized.
      credentials: { type: DataTypes.TEXT, allowNull: false },
      hint: { type: DataTypes.STRING(120), allowNull: true },
      locale: { type: DataTypes.STRING(2), allowNull: false, defaultValue: 'ar' },
      types: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      lastStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'last_status' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
      lastSentAt: { type: DataTypes.DATE, allowNull: true, field: 'last_sent_at' },
      failureCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'failure_count' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'team_channels' }
  );
  TeamChannel.associate = (models) => {
    TeamChannel.hasMany(models.TeamChannelDelivery, { foreignKey: 'teamChannelId', as: 'deliveries' });
  };
  return TeamChannel;
};
