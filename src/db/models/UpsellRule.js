'use strict';

module.exports = (sequelize, DataTypes) => {
  // The one-tap offer on the thank-you page (null trigger: after any order) — migration 150, modules/offers.
  const UpsellRule = sequelize.define(
    'UpsellRule',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      triggerProductId: { type: DataTypes.UUID, allowNull: true, field: 'trigger_product_id' },
      offerId: { type: DataTypes.UUID, allowNull: false, field: 'offer_id' },
      headline: { type: DataTypes.STRING(120), allowNull: true },
      description: { type: DataTypes.STRING(300), allowNull: true },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'upsell_rules' }
  );

  return UpsellRule;
};
