'use strict';

module.exports = (sequelize, DataTypes) => {
  // A person's two-step sign-in (modules/auth/twoFactorService.js). Secrets are sealed.
  const UserTwoFactor = sequelize.define(
    'UserTwoFactor',
    {
      userId: { type: DataTypes.UUID, primaryKey: true, field: 'user_id' },
      mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'off' },
      totpSecretSealed: { type: DataTypes.TEXT, allowNull: true, field: 'totp_secret_sealed' },
      pendingSecretSealed: { type: DataTypes.TEXT, allowNull: true, field: 'pending_secret_sealed' },
      enabledAt: { type: DataTypes.DATE, allowNull: true, field: 'enabled_at' },
      // One-time backup codes, hashed: [{ hash, usedAt }] (migration 621, auth/twoFactorRecovery.js).
      backupCodes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'backup_codes' },
      backupCodesCreatedAt: { type: DataTypes.DATE, allowNull: true, field: 'backup_codes_created_at' },
    },
    { tableName: 'user_two_factor' }
  );
  return UserTwoFactor;
};
