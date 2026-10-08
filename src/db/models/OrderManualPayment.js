'use strict';

module.exports = (sequelize, DataTypes) => {
  // An order paid with one of the store's manual methods (migration 209):
  // the method as the shopper saw it, then their proof and the merchant's
  // review. awaiting_proof -> submitted -> approved | rejected (a rejected
  // proof may be sent again).
  const OrderManualPayment = sequelize.define(
    'OrderManualPayment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      methodId: { type: DataTypes.UUID, allowNull: true, field: 'method_id' },
      kind: { type: DataTypes.STRING(10), allowNull: false },
      label: { type: DataTypes.STRING(80), allowNull: false },
      accountNumber: { type: DataTypes.STRING(80), allowNull: false, field: 'account_number' },
      paymentLink: { type: DataTypes.STRING(500), allowNull: true, field: 'payment_link' },
      instructions: { type: DataTypes.STRING(1000), allowNull: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'awaiting_proof' },
      payerNumber: { type: DataTypes.STRING(60), allowNull: true, field: 'payer_number' },
      // A private customer_uploads row; staff see it through a signed link.
      proofUploadId: { type: DataTypes.UUID, allowNull: true, field: 'proof_upload_id' },
      submittedAt: { type: DataTypes.DATE, allowNull: true, field: 'submitted_at' },
      reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by_user_id' },
      rejectionReason: { type: DataTypes.STRING(500), allowNull: true, field: 'rejection_reason' },
    },
    { tableName: 'order_manual_payments' }
  );
  OrderManualPayment.STATUSES = ['awaiting_proof', 'submitted', 'approved', 'rejected'];
  return OrderManualPayment;
};
