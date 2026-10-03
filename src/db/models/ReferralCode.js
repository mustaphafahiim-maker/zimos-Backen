'use strict';

module.exports = (sequelize, DataTypes) => {
  // An agent's referral code (migration 106). `discountValue` is basis points
  // for a percentage and minor units of `discountCurrency` for a fixed amount,
  // like the merchant Discount model. Never deleted, only deactivated.
  const ReferralCode = sequelize.define(
    'ReferralCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      agentId: { type: DataTypes.UUID, allowNull: false, field: 'agent_id' },
      code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      label: { type: DataTypes.STRING(120), allowNull: true },
      discountType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'none', field: 'discount_type' },
      discountValue: { type: DataTypes.BIGINT, allowNull: true, field: 'discount_value' },
      discountCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'discount_currency' },
      // Null = the platform default (referrals/commissionPolicy.js).
      commissionRateBp: { type: DataTypes.INTEGER, allowNull: true, field: 'commission_rate_bp' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'referral_codes' }
  );
  ReferralCode.associate = (models) => {
    ReferralCode.belongsTo(models.User, { foreignKey: 'agentId', as: 'agent' });
    ReferralCode.hasMany(models.Subscription, { foreignKey: 'referralCodeId', as: 'subscriptions' });
  };
  return ReferralCode;
};
