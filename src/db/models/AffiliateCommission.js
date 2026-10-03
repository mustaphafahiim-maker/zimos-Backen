'use strict';

module.exports = (sequelize, DataTypes) => {
  // What one referred order earns its affiliate (migration 314). Written only
  // by modules/affiliates/commissionService.js.
  const AffiliateCommission = sequelize.define(
    'AffiliateCommission',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      affiliateId: { type: DataTypes.UUID, allowNull: false, field: 'affiliate_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      baseAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'base_amount' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      // 'pending' | 'approved' | 'paid' | 'void'
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      payoutId: { type: DataTypes.UUID, allowNull: true, field: 'payout_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
      voidedAt: { type: DataTypes.DATE, allowNull: true, field: 'voided_at' },
    },
    { tableName: 'affiliate_commissions', indexes: [{ unique: true, fields: ['order_id'], name: 'affiliate_commissions_order_uq' }] }
  );

  AffiliateCommission.associate = (models) => {
    AffiliateCommission.belongsTo(models.Affiliate, { foreignKey: 'affiliateId', as: 'affiliate' });
    AffiliateCommission.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return AffiliateCommission;
};
