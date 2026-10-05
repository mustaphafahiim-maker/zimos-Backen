'use strict';

module.exports = (sequelize, DataTypes) => {
  // One accepted post-purchase upsell per order — migration 150, modules/offers.
  const UpsellAcceptance = sequelize.define(
    'UpsellAcceptance',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      upsellRuleId: { type: DataTypes.UUID, allowNull: true, field: 'upsell_rule_id' },
      offerId: { type: DataTypes.UUID, allowNull: false, field: 'offer_id' },
      orderItemId: { type: DataTypes.UUID, allowNull: true, field: 'order_item_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'upsell_acceptances', indexes: [{ unique: true, fields: ['order_id'] }] }
  );

  return UpsellAcceptance;
};
