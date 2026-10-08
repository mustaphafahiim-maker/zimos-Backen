'use strict';

module.exports = (sequelize, DataTypes) => {
  // A payout a gateway sent to the merchant's bank (item 384, migration 521,
  // modules/payments/ledger/payoutSync.js). Its payments and refunds point at it
  // with payout_id.
  const GatewayPayout = sequelize.define(
    'GatewayPayout',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      mode: { type: DataTypes.STRING(10), allowNull: true },
      externalId: { type: DataTypes.STRING(100), allowNull: false, field: 'external_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      feeAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'fee_amount' },
      arrivalDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'arrival_date' },
      // pending | in_transit | paid | failed | canceled
      status: { type: DataTypes.STRING(20), allowNull: false },
      unmatchedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'unmatched_count' },
      unmatchedAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'unmatched_amount' },
      syncedAt: { type: DataTypes.DATE, allowNull: false, field: 'synced_at' },
    },
    { tableName: 'gateway_payouts' }
  );
  return GatewayPayout;
};
