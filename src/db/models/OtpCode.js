'use strict';

module.exports = (sequelize, DataTypes) => {
  // Generic one-time SMS codes. The raw code is never stored — only
  // `codeHash` (sha256). `attempts` caps brute force per code; `consumedAt`
  // makes a successful verification single-use. See modules/otp/otpService.js.
  const OtpCode = sequelize.define(
    'OtpCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      phone: { type: DataTypes.STRING(32), allowNull: false },
      purpose: { type: DataTypes.STRING(50), allowNull: false },
      codeHash: { type: DataTypes.STRING(128), allowNull: false, field: 'code_hash' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      consumedAt: { type: DataTypes.DATE, allowNull: true, field: 'consumed_at' },
      // The store a checkout code was sent for (item 348); null for the other purposes.
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      // The client a checkout code was asked for by (an IPv6 /56): the per-IP send budget.
      requestIp: { type: DataTypes.STRING(64), allowNull: true, field: 'request_ip' },
    },
    {
      tableName: 'otp_codes',
      indexes: [
        { fields: ['phone', 'purpose'] },
        { fields: ['phone', 'created_at'] },
        { fields: ['request_ip', 'created_at'] },
      ],
    }
  );

  return OtpCode;
};
