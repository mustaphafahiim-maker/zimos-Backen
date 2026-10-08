'use strict';

module.exports = (sequelize, DataTypes) => {
  // One message sent (or tried) to a team channel (item 378, migration 512).
  const TeamChannelDelivery = sequelize.define(
    'TeamChannelDelivery',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      teamChannelId: { type: DataTypes.UUID, allowNull: false, field: 'team_channel_id' },
      // A notification type, 'test' or 'automation_step'.
      type: { type: DataTypes.STRING(60), allowNull: false },
      dedupeKey: { type: DataTypes.STRING(200), allowNull: true, field: 'dedupe_key' },
      // sent | failed
      status: { type: DataTypes.STRING(20), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
    },
    { tableName: 'team_channel_deliveries' }
  );
  TeamChannelDelivery.associate = (models) => {
    TeamChannelDelivery.belongsTo(models.TeamChannel, { foreignKey: 'teamChannelId', as: 'channel' });
  };
  return TeamChannelDelivery;
};
