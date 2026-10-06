'use strict';

/**
 * Returns asked for by the shopper (modules/returns/shopperReturns.js,
 * spec-gaps item 186): who opened it, and the photos they attached
 * (customer_uploads ids).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('return_requests', 'source', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'merchant' });
    await queryInterface.addColumn('return_requests', 'photo_upload_ids', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('return_requests', 'photo_upload_ids');
    await queryInterface.removeColumn('return_requests', 'source');
  },
};
