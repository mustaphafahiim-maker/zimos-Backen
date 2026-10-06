'use strict';

module.exports = (sequelize, DataTypes) => {
  // A sign-in email change waiting for the new address to confirm it (migration 425, auth/emailChange.js).
  const EmailChange = sequelize.define(
    'EmailChange',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      oldEmail: { type: DataTypes.STRING(255), allowNull: false, field: 'old_email' },
      newEmail: { type: DataTypes.STRING(255), allowNull: false, field: 'new_email' },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'token_hash' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      usedAt: { type: DataTypes.DATE, allowNull: true, field: 'used_at' },
    },
    { tableName: 'email_changes' }
  );
  return EmailChange;
};
