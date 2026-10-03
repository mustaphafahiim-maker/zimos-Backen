'use strict';

module.exports = (sequelize, DataTypes) => {
  // A payment to an affiliate the merchant recorded by hand (migration 314).
  const AffiliatePayout = sequelize.define(
    'AffiliatePayout',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      affiliateId: { type: DataTypes.UUID, allowNull: false, field: 'affiliate_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      method: { type: DataTypes.STRING(40), allowNull: true },
      note: { type: DataTypes.STRING(300), allowNull: true },
      paidAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'paid_at' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'affiliate_payouts' }
  );
  return AffiliatePayout;
};
