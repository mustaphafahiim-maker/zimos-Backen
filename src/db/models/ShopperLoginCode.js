'use strict';

module.exports = (sequelize, DataTypes) => {
  // A sign-in code sent to a shopper (modules/shopperAccounts, migration 670).
  // Only an HMAC of the code is stored.
  const ShopperLoginCode = sequelize.define(
    'ShopperLoginCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      channel: { type: DataTypes.STRING(10), allowNull: false },
      target: { type: DataTypes.STRING(255), allowNull: false },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      codeHash: { type: DataTypes.STRING(64), allowNull: false, field: 'code_hash' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      consumedAt: { type: DataTypes.DATE, allowNull: true, field: 'consumed_at' },
      supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
      requestIp: { type: DataTypes.STRING(45), allowNull: true, field: 'request_ip' },
    },
    { tableName: 'shopper_login_codes' }
  );
  return ShopperLoginCode;
};
