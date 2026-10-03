'use strict';

module.exports = (sequelize, DataTypes) => {
  // A sign-in waiting for its second step (modules/auth/twoFactorService.js).
  const LoginChallenge = sequelize.define(
    'LoginChallenge',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      channel: { type: DataTypes.STRING(10), allowNull: false },
      codeHash: { type: DataTypes.STRING(64), allowNull: true, field: 'code_hash' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      consumedAt: { type: DataTypes.DATE, allowNull: true, field: 'consumed_at' },
      ipAddress: { type: DataTypes.STRING(64), allowNull: true, field: 'ip_address' },
    },
    { tableName: 'login_challenges' }
  );
  return LoginChallenge;
};
