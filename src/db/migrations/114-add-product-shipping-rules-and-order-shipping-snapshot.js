'use strict';

/**
 * Merchant-defined shipping, product side and order side.
 *
 * products.shipping_mode           'standard' (the store's rates, the default
 *                                  for every existing product), 'free' or
 *                                  'extra_fee'.
 * products.shipping_extra_amount   the extra fee per unit, in minor units;
 *                                  set exactly when the mode is 'extra_fee'.
 *
 * orders.shipping_snapshot         how the order's shipping amount was reached
 *                                  (rule, base, extra fees, governorate,
 *                                  threshold) — for the dashboard to explain
 *                                  the fee. Null on orders placed before this.
 *
 * How the three combine in a mixed cart is shipping/shippingRules.js. Every
 * existing product starts 'standard', so no store's prices change until a
 * merchant sets a product's mode.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'products',
        'shipping_mode',
        { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'standard' },
        { transaction }
      );
      await queryInterface.addColumn(
        'products',
        'shipping_extra_amount',
        { type: DataTypes.BIGINT, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE products
           ADD CONSTRAINT products_shipping_mode_check
             CHECK (shipping_mode IN ('standard', 'free', 'extra_fee')),
           ADD CONSTRAINT products_shipping_extra_amount_check
             CHECK ((shipping_mode = 'extra_fee') = (shipping_extra_amount IS NOT NULL)
                    AND (shipping_extra_amount IS NULL OR shipping_extra_amount > 0))`,
        { transaction }
      );
      await queryInterface.addColumn('orders', 'shipping_snapshot', { type: DataTypes.JSONB, allowNull: true }, { transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('orders', 'shipping_snapshot', { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE products
           DROP CONSTRAINT products_shipping_extra_amount_check,
           DROP CONSTRAINT products_shipping_mode_check`,
        { transaction }
      );
      await queryInterface.removeColumn('products', 'shipping_extra_amount', { transaction });
      await queryInterface.removeColumn('products', 'shipping_mode', { transaction });
    });
  },
};
