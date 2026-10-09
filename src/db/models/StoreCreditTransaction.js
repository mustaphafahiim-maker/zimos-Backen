'use strict';

module.exports = (sequelize, DataTypes) => {
  // One change of a customer's store credit (migration 681, modules/storeCredit).
  const StoreCreditTransaction = sequelize.define(
    'StoreCreditTransaction',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      balanceAfter: { type: DataTypes.BIGINT, allowNull: false, field: 'balance_after' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      paymentId: { type: DataTypes.UUID, allowNull: true, field: 'payment_id' },
      refundId: { type: DataTypes.UUID, allowNull: true, field: 'refund_id' },
      note: { type: DataTypes.STRING(200), allowNull: true },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
    },
    { tableName: 'store_credit_transactions' }
  );
  return StoreCreditTransaction;
};
