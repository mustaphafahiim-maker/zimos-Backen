'use strict';

module.exports = (sequelize, DataTypes) => {
  // How much of a refund request comes from one paid top-up (migration 223).
  const WalletRefundAllocation = sequelize.define(
    'WalletRefundAllocation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      refundRequestId: { type: DataTypes.UUID, allowNull: false, field: 'refund_request_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // The wallet_ledger_entries row of the top-up.
      topupEntryId: { type: DataTypes.UUID, allowNull: false, field: 'topup_entry_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
    },
    { tableName: 'wallet_refund_allocations', underscored: true, updatedAt: false }
  );
  return WalletRefundAllocation;
};
