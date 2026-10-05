'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Product fields of SPEC §7.1–7.4 (lane 3): display priority, the "special
 * offer" line above the buy button, references to the same product on outside
 * platforms, the product page's settings and its structured content (features,
 * testimonials, FAQs). Option display types live inside the existing
 * `options` jsonb and need no column.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('products', 'priority', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('products', 'special_offer_text', {
      type: Sequelize.STRING(200),
      allowNull: true,
    });
    await queryInterface.addColumn('products', 'external_refs', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
    });
    await queryInterface.addColumn('products', 'page_settings', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: {},
    });
    await queryInterface.addColumn('products', 'cms', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: {},
    });
    await queryInterface.addIndex('products', ['workspace_id', 'priority'], { name: 'products_workspace_priority' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeIndex('products', 'products_workspace_priority');
    await queryInterface.removeColumn('products', 'cms');
    await queryInterface.removeColumn('products', 'page_settings');
    await queryInterface.removeColumn('products', 'external_refs');
    await queryInterface.removeColumn('products', 'special_offer_text');
    await queryInterface.removeColumn('products', 'priority');
  },
};
