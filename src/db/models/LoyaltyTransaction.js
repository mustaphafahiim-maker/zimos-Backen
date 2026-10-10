'use strict';

module.exports = (sequelize, DataTypes) => {
  // One change of a customer's loyalty points (migration 680, modules/loyalty).
  const LoyaltyTransaction = sequelize.define(
    'LoyaltyTransaction',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      points: { type: DataTypes.INTEGER, allowNull: false },
      balanceAfter: { type: DataTypes.INTEGER, allowNull: false, field: 'balance_after' },
      amount: { type: DataTypes.BIGINT, allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      paymentId: { type: DataTypes.UUID, allowNull: true, field: 'payment_id' },
      note: { type: DataTypes.STRING(200), allowNull: true },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
    },
    { tableName: 'loyalty_transactions' }
  );
  return LoyaltyTransaction;
};
