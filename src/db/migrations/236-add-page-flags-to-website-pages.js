'use strict';

/**
 * website_pages: where a page is linked from and whether it is served at all
 * (SPEC §8.3). `show_in_header` / `show_in_footer` put a published page in the
 * store's navigation; `is_active = false` takes it off the store without
 * unpublishing or deleting it. They are live switches, not part of the
 * published snapshot (modules/pages/pageFlags.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('website_pages', 'show_in_header', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('website_pages', 'show_in_footer', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('website_pages', 'is_active', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('website_pages', 'is_active');
    await queryInterface.removeColumn('website_pages', 'show_in_footer');
    await queryInterface.removeColumn('website_pages', 'show_in_header');
  },
};
