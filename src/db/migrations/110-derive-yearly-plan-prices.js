'use strict';

/**
 * Annual plan price = 10 × the monthly price (billing/planPricing.js). The
 * column stays, but is now always derived: this brings existing plans in line
 * (the default Starter plan was 299900 against 10 × 29900 = 299000), and every
 * plan save writes it from the monthly price from here on.
 *
 * `down` does not restore the old free-form values — they were admin-entered
 * and are not kept. Rolling back leaves the derived ones, which the previous
 * release reads fine.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query('UPDATE plans SET yearly_price_amount = monthly_price_amount * 10');
  },

  down: async () => {},
};
