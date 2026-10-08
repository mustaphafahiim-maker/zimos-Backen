'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant's request for unused prepaid balance back (migration 223,
  // billing/walletRefundService): requested → approved → paid out by hand,
  // or rejected / cancelled. One open per store.
  const WalletRefundRequest = sequelize.define(
    'WalletRefundRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      status: { type: DataTypes.STRING(12), allowNull: false },
      // Where the merchant wants it sent (an InstaPay address, a wallet number).
      payoutMethod: { type: DataTypes.STRING(30), allowNull: true, field: 'payout_method' },
      payoutAccount: { type: DataTypes.STRING(120), allowNull: true, field: 'payout_account' },
      // The console's reference for the transfer it made.
      payoutReference: { type: DataTypes.STRING(200), allowNull: true, field: 'payout_reference' },
      adminNote: { type: DataTypes.STRING(500), allowNull: true, field: 'admin_note' },
      requestKey: { type: DataTypes.STRING(80), allowNull: true, unique: true, field: 'request_key' },
      requestedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'requested_by_user_id' },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by_user_id' },
      paidByUserId: { type: DataTypes.UUID, allowNull: true, field: 'paid_by_user_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      rejectedAt: { type: DataTypes.DATE, allowNull: true, field: 'rejected_at' },
      cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
    },
    { tableName: 'wallet_refund_requests', underscored: true }
  );
  WalletRefundRequest.OPEN = ['requested', 'approved'];
  // The statuses whose allocations still count against a top-up's ceiling.
  WalletRefundRequest.HOLDING = ['requested', 'approved', 'paid'];
  WalletRefundRequest.associate = (models) => {
    WalletRefundRequest.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    WalletRefundRequest.hasMany(models.WalletRefundAllocation, { foreignKey: 'refundRequestId', as: 'allocations' });
  };
  return WalletRefundRequest;
};
