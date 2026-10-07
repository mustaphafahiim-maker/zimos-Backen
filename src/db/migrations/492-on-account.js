'use strict';

/** Pay later on account (net terms) for approved business customers (modules/accountCredit, spec-gaps item 229). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query("ALTER TYPE \"enum_orders_payment_method\" ADD VALUE IF NOT EXISTS 'on_account'");
    await queryInterface.addColumn('customers', 'on_account_enabled', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    // The most this customer may owe at once (minor units); null = no limit.
    await queryInterface.addColumn('customers', 'credit_limit', { type: Sequelize.BIGINT, allowNull: true });
    // Days after the order to pay.
    await queryInterface.addColumn('customers', 'payment_terms_days', { type: Sequelize.INTEGER, allowNull: true });
    await queryInterface.addColumn('orders', 'payment_due_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addIndex('orders', ['workspace_id', 'payment_method', 'payment_due_at'], { name: 'orders_on_account_due_idx', where: { payment_method: 'on_account' } });
  },
  down: async (queryInterface) => {
    await queryInterface.removeIndex('orders', 'orders_on_account_due_idx');
    await queryInterface.removeColumn('orders', 'payment_due_at');
    await queryInterface.removeColumn('customers', 'payment_terms_days');
    await queryInterface.removeColumn('customers', 'credit_limit');
    await queryInterface.removeColumn('customers', 'on_account_enabled');
  },
};
