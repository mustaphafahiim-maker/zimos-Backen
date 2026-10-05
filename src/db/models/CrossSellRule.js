'use strict';

module.exports = (sequelize, DataTypes) => {
  // Products to suggest beside the ones in the cart or order — migration 150, modules/offers.
  const CrossSellRule = sequelize.define(
    'CrossSellRule',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      triggerProductIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'trigger_product_ids' },
      triggerCollectionIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'trigger_collection_ids' },
      offerProductIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'offer_product_ids' },
      // 'cart' | 'checkout' | 'thank_you'
      placement: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'cart' },
      maxItems: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4, field: 'max_items' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'cross_sell_rules' }
  );

  return CrossSellRule;
};
