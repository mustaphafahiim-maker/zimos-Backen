'use strict';

/** Business customers: company, tax ID and tax exemption (modules/businessCustomers, spec-gaps item 228). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('customers', 'company_name', { type: Sequelize.STRING(200), allowNull: true });
    await queryInterface.addColumn('customers', 'tax_id', { type: Sequelize.STRING(40), allowNull: true });
    // Set by the store only; the checkout honours it for that signed-in customer.
    await queryInterface.addColumn('customers', 'tax_exempt', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('customers', 'tax_exempt_note', { type: Sequelize.STRING(300), allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('customers', 'tax_exempt_note');
    await queryInterface.removeColumn('customers', 'tax_exempt');
    await queryInterface.removeColumn('customers', 'tax_id');
    await queryInterface.removeColumn('customers', 'company_name');
  },
};
