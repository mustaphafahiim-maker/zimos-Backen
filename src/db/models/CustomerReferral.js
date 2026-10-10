'use strict';

module.exports = (sequelize, DataTypes) => {
  // A friend's first order placed with a shopper's invite (migration 682, modules/customerReferrals).
  const CustomerReferral = sequelize.define(
    'CustomerReferral',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      referrerCustomerId: { type: DataTypes.UUID, allowNull: false, field: 'referrer_customer_id' },
      friendCustomerId: { type: DataTypes.UUID, allowNull: true, field: 'friend_customer_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      friendOffer: { type: DataTypes.JSONB, allowNull: true, field: 'friend_offer' },
      reward: { type: DataTypes.JSONB, allowNull: true },
      voidReason: { type: DataTypes.STRING(40), allowNull: true, field: 'void_reason' },
      rewardedAt: { type: DataTypes.DATE, allowNull: true, field: 'rewarded_at' },
    },
    { tableName: 'customer_referrals' }
  );
  CustomerReferral.associate = (models) => {
    CustomerReferral.belongsTo(models.Customer, { foreignKey: 'referrerCustomerId', as: 'referrer' });
    CustomerReferral.belongsTo(models.Customer, { foreignKey: 'friendCustomerId', as: 'friend' });
    CustomerReferral.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return CustomerReferral;
};
