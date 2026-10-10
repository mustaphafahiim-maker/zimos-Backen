'use strict';

module.exports = (sequelize, DataTypes) => {
  // A shopper's own invite code (migration 682, modules/customerReferrals).
  const CustomerReferralCode = sequelize.define(
    'CustomerReferralCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      code: { type: DataTypes.STRING(16), allowNull: false },
    },
    { tableName: 'customer_referral_codes' }
  );
  return CustomerReferralCode;
};
