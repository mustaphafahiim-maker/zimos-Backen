'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Collections (SPEC §7.6): `show_in_header` puts a collection in the store's
 * header menu; `hidden` keeps it out of every public list while its own link
 * still opens.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('collections', 'show_in_header', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('collections', 'hidden', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('collections', 'hidden');
    await queryInterface.removeColumn('collections', 'show_in_header');
  },
};
