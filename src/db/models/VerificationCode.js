'use strict';

module.exports = (sequelize, DataTypes) => {
  // A 6-digit code confirming a new account (migration 126), sent by email or
  // SMS (otp/verificationCodeService). Only a hash of the code is stored.
  // Dead once consumed, superseded by a newer code, expired, or out of
  // attempts.
  const VerificationCode = sequelize.define(
    'VerificationCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      // 'email' | 'sms' (CHECK constraint).
      channel: { type: DataTypes.STRING(10), allowNull: false },
      target: { type: DataTypes.STRING(255), allowNull: false },
      codeHash: { type: DataTypes.STRING(128), allowNull: false, field: 'code_hash' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      consumedAt: { type: DataTypes.DATE, allowNull: true, field: 'consumed_at' },
      supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
      requestIp: { type: DataTypes.STRING(64), allowNull: true, field: 'request_ip' },
    },
    { tableName: 'verification_codes' }
  );
  return VerificationCode;
};
