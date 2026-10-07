'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant's proof of a manual transfer, waiting for a platform admin
  // (migration 130, billing/paymentProofService).
  const PaymentProof = sequelize.define(
    'PaymentProof',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // 'invoice' (a subscription charge)
      purpose: { type: DataTypes.STRING(20), allowNull: false },
      billingInvoiceId: { type: DataTypes.UUID, allowNull: true, field: 'billing_invoice_id' },
      paymentMethodId: { type: DataTypes.UUID, allowNull: false, field: 'payment_method_id' },
      // The method and the number the money was sent to, as they were then.
      methodCode: { type: DataTypes.STRING(40), allowNull: false, field: 'method_code' },
      receivingNumber: { type: DataTypes.STRING(80), allowNull: false, field: 'receiving_number' },
      // Normalised: 20 then the mobile number.
      senderPhone: { type: DataTypes.STRING(20), allowNull: false, field: 'sender_phone' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      // Priced by the server when the proof was sent; for a charge, with its
      // discount and code frozen as an online checkout freezes them.
      requestedAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'requested_amount' },
      grossAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'gross_amount' },
      discountAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'discount_amount' },
      referralCodeId: { type: DataTypes.UUID, allowNull: true, field: 'referral_code_id' },
      // What the reviewer saw arrive.
      receivedAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'received_amount' },
      // pending | approved | rejected
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      reviewNote: { type: DataTypes.STRING(1000), allowNull: true, field: 'review_note' },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by_user_id' },
      reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
      submittedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'submitted_by_user_id' },
      // Private storage only; read through a signed, short-lived link.
      imageKey: { type: DataTypes.STRING(255), allowNull: false, field: 'image_key' },
      imageMime: { type: DataTypes.STRING(30), allowNull: false, field: 'image_mime' },
      imageBytes: { type: DataTypes.INTEGER, allowNull: false, field: 'image_bytes' },
      imageSha256: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'image_sha256' },
    },
    { tableName: 'payment_proofs' }
  );
  PaymentProof.STATUSES = ['pending', 'approved', 'rejected'];

  PaymentProof.associate = (models) => {
    PaymentProof.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    PaymentProof.belongsTo(models.BillingInvoice, { foreignKey: 'billingInvoiceId', as: 'invoice' });
    PaymentProof.belongsTo(models.PaymentMethod, { foreignKey: 'paymentMethodId', as: 'method' });
    PaymentProof.belongsTo(models.User, { foreignKey: 'reviewedByUserId', as: 'reviewedBy' });
    PaymentProof.belongsTo(models.User, { foreignKey: 'submittedByUserId', as: 'submittedBy' });
  };
  return PaymentProof;
};
