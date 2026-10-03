'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's prepaid balance (migration 131, billing/walletService): a cache
  // of its ledger, written in the same transaction as each entry.
  const WorkspaceWallet = sequelize.define(
    'WorkspaceWallet',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, unique: true, field: 'workspace_id' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      // May go below zero, down to the overdraft walletService allows.
      cashBalance: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'cash_balance' },
      totalToppedUp: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'total_topped_up' },
    },
    { tableName: 'workspace_wallets' }
  );
  return WorkspaceWallet;
};
