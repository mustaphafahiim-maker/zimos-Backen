'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's gift card (migration 464, modules/giftCards). The code itself is
  // only sealed (secretBox) and hashed (HMAC) — never stored in clear.
  const GiftCard = sequelize.define(
    'GiftCard',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      codeHash: { type: DataTypes.STRING(64), allowNull: false, field: 'code_hash' },
      codeSealed: { type: DataTypes.TEXT, allowNull: false, field: 'code_sealed' },
      last4: { type: DataTypes.STRING(4), allowNull: false },
      initialAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'initial_amount' },
      balanceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'balance_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      orderItemId: { type: DataTypes.UUID, allowNull: true, field: 'order_item_id' },
      unitIndex: { type: DataTypes.INTEGER, allowNull: true, field: 'unit_index' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      recipientName: { type: DataTypes.STRING(200), allowNull: true, field: 'recipient_name' },
      recipientEmail: { type: DataTypes.STRING(255), allowNull: true, field: 'recipient_email' },
      message: { type: DataTypes.STRING(500), allowNull: true },
      note: { type: DataTypes.STRING(500), allowNull: true },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'gift_cards' }
  );
  return GiftCard;
};
