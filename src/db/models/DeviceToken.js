'use strict';

module.exports = (sequelize, DataTypes) => {
  // A browser or phone a person gets push notifications on (migration 411, notifications/push).
  const DeviceToken = sequelize.define(
    'DeviceToken',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      platform: { type: DataTypes.STRING(10), allowNull: false },
      token: { type: DataTypes.TEXT, allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'token_hash' },
      userAgent: { type: DataTypes.STRING(300), allowNull: true, field: 'user_agent' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'last_seen_at' },
    },
    { tableName: 'device_tokens' }
  );
  return DeviceToken;
};
