'use strict';

module.exports = (sequelize, DataTypes) => {
  // Every field here is a SNAPSHOT taken at order-creation time. Later
  // changes to the Product/Variant/Offer must never alter historical orders
  // — that's the entire point of duplicating the data instead of joining.
  const OrderItem = sequelize.define(
    'OrderItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      variantId: { type: DataTypes.UUID, allowNull: true, field: 'variant_id' },
      // The expected ship date when the line was taken as a pre-order (migration 468, modules/preorders).
      preorderShipsAt: { type: DataTypes.DATEONLY, allowNull: true, field: 'preorder_ships_at' },
      offerId: { type: DataTypes.UUID, allowNull: true, field: 'offer_id' },

      productNameSnapshot: { type: DataTypes.STRING(300), allowNull: false, field: 'product_name_snapshot' },
      variantOptionsSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'variant_options_snapshot' },
      skuSnapshot: { type: DataTypes.STRING(100), allowNull: true, field: 'sku_snapshot' },
      offerNameSnapshot: { type: DataTypes.STRING(200), allowNull: true, field: 'offer_name_snapshot' },

      quantity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
      unitPriceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'unit_price_amount' },
      unitCostAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'unit_cost_amount' },
      lineDiscountAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'line_discount_amount' },
      lineTotalAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'line_total_amount' },
      isOrderBump: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_order_bump' },
      isUpsell: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_upsell' },
      // A free gift the server added (freeGifts/, item 276; migration 513); null on older lines.
      isFreeGift: { type: DataTypes.BOOLEAN, allowNull: true, field: 'is_free_gift' },
      // A line staff priced themselves (orders/staffPricing.js, item 382; migration 518): { kind: override|custom, catalogUnitPriceAmount?, actorUserId, actorName, at }.
      priceOverride: { type: DataTypes.JSONB, allowNull: true, field: 'price_override' },
      // One unit of the line (one bundle for an offer); null when unknown.
      unitWeightGrams: { type: DataTypes.INTEGER, allowNull: true, field: 'unit_weight_grams' },
      // What the shopper filled in for the product's custom fields, labels
      // included as they were when ordered. Photos by upload id.
      customizations: { type: DataTypes.JSONB, allowNull: true },
    },
    { tableName: 'order_items', indexes: [{ fields: ['order_id'] }] }
  );

  OrderItem.associate = (models) => {
    OrderItem.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };

  return OrderItem;
};
