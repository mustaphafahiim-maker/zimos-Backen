'use strict';

module.exports = (sequelize, DataTypes) => {
  // A saved-card token a gateway sent on its own callback (Paymob TOKEN), held until it is saved for the
  // customer (payments/savedMethods/heldCardTokens.js, item 380). `tokenSealed` is never returned or logged.
  const GatewayCardToken = sequelize.define(
    'GatewayCardToken',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      paymentId: { type: DataTypes.UUID, allowNull: false, field: 'payment_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      tokenSealed: { type: DataTypes.TEXT, allowNull: false, field: 'token_sealed' },
      brand: { type: DataTypes.STRING(30), allowNull: true },
      last4: { type: DataTypes.STRING(4), allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    },
    { tableName: 'gateway_card_tokens' }
  );
  return GatewayCardToken;
};
