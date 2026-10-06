'use strict';

/**
 * What an import made (frontend request on item 180): `catalog_imports.results`
 * = [{ row, productId, name, sourceCurrency, reviewsImported }], one per
 * product created, so the dashboard can open the new drafts.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('catalog_imports', 'results', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('catalog_imports', 'results');
  },
};
