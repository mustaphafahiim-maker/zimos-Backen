'use strict';

module.exports = (sequelize, DataTypes) => {
  // A card dispute or chargeback the gateway reported (item 377, migration 511,
  // modules/payments/disputeService.js).
  const PaymentDispute = sequelize.define(
    'PaymentDispute',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      paymentId: { type: DataTypes.UUID, allowNull: false, field: 'payment_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      providerDisputeId: { type: DataTypes.STRING(100), allowNull: false, field: 'provider_dispute_id' },
      // inquiry | needs_response | under_review | won | lost | closed
      status: { type: DataTypes.STRING(20), allowNull: false },
      providerStatus: { type: DataTypes.STRING(60), allowNull: true, field: 'provider_status' },
      amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      reason: { type: DataTypes.STRING(100), allowNull: true },
      evidenceDueBy: { type: DataTypes.DATE, allowNull: true, field: 'evidence_due_by' },
      openedAt: { type: DataTypes.DATE, allowNull: true, field: 'opened_at' },
      closedAt: { type: DataTypes.DATE, allowNull: true, field: 'closed_at' },
      refundId: { type: DataTypes.UUID, allowNull: true, field: 'refund_id' },
    },
    { tableName: 'payment_disputes' }
  );
  PaymentDispute.associate = (models) => {
    PaymentDispute.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    PaymentDispute.belongsTo(models.Payment, { foreignKey: 'paymentId', as: 'payment' });
  };
  return PaymentDispute;
};
