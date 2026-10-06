'use strict';

module.exports = (sequelize, DataTypes) => {
  // One change of a gift card's balance (migration 464): issue, redeem, refund, adjust.
  const GiftCardTransaction = sequelize.define(
    'GiftCardTransaction',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      giftCardId: { type: DataTypes.UUID, allowNull: false, field: 'gift_card_id' },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      balanceAfter: { type: DataTypes.BIGINT, allowNull: false, field: 'balance_after' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      paymentId: { type: DataTypes.UUID, allowNull: true, field: 'payment_id' },
      note: { type: DataTypes.STRING(300), allowNull: true },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
    },
    { tableName: 'gift_card_transactions' }
  );
  return GiftCardTransaction;
};
