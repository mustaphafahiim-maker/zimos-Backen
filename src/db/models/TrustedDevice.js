'use strict';

module.exports = (sequelize, DataTypes) => {
  // A browser that passed the second sign-in step and is remembered; only a hash of its cookie is kept.
  const TrustedDevice = sequelize.define(
    'TrustedDevice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      deviceHash: { type: DataTypes.STRING(64), allowNull: false, field: 'device_hash' },
      userAgent: { type: DataTypes.STRING(500), allowNull: true, field: 'user_agent' },
      lastUsedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'last_used_at' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    },
    { tableName: 'trusted_devices' }
  );
  return TrustedDevice;
};
