'use strict';

const { guarded } = require('../migrationGuards');

/**
 * What a manual subscription costs the merchant (billing/manualPricing):
 *
 *   subscriptions.pricing_kind           'paid' (the plan's price, as before),
 *                                        'free' (a gift) or 'discounted'
 *   subscriptions.discount_percent       1-99, a discounted one off the plan price
 *   subscriptions.price_override_amount  a discounted one's price per billing
 *                                        period, minor units (instead of a percent)
 *   subscriptions.granted_by_user_id     the console admin who set it
 *   subscriptions.pricing_expired_at     when a free or discounted period ran
 *                                        out (the sweep moved it to past_due)
 *
 * Every existing row is 'paid', which is what it was.
 */
const CHECKS = [
  ['subscriptions_pricing_kind_check', "pricing_kind IN ('paid', 'free', 'discounted')"],
  ['subscriptions_discount_percent_check', 'discount_percent IS NULL OR (discount_percent BETWEEN 1 AND 99)'],
  ['subscriptions_price_override_amount_check', 'price_override_amount IS NULL OR price_override_amount >= 0'],
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('subscriptions', 'pricing_kind', { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'paid' }, { transaction });
      await queryInterface.addColumn('subscriptions', 'discount_percent', { type: DataTypes.INTEGER, allowNull: true }, { transaction });
      await queryInterface.addColumn('subscriptions', 'price_override_amount', { type: DataTypes.BIGINT, allowNull: true }, { transaction });
      await queryInterface.addColumn('subscriptions', 'granted_by_user_id', { type: DataTypes.UUID, allowNull: true }, { transaction });
      await queryInterface.addColumn('subscriptions', 'pricing_expired_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      for (const [name, check] of CHECKS) {
        await queryInterface.sequelize.query(`ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS ${name}`, { transaction });
        await queryInterface.sequelize.query(`ALTER TABLE subscriptions ADD CONSTRAINT ${name} CHECK (${check})`, { transaction });
      }
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const [name] of CHECKS) {
        await queryInterface.sequelize.query(`ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS ${name}`, { transaction });
      }
      await queryInterface.removeColumn('subscriptions', 'pricing_expired_at', { transaction });
      await queryInterface.removeColumn('subscriptions', 'granted_by_user_id', { transaction });
      await queryInterface.removeColumn('subscriptions', 'price_override_amount', { transaction });
      await queryInterface.removeColumn('subscriptions', 'discount_percent', { transaction });
      await queryInterface.removeColumn('subscriptions', 'pricing_kind', { transaction });
    });
  },
};
