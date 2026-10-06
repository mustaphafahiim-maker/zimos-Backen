'use strict';

/**
 * Mix-and-match boxes (spec-gaps item 215): a quantity bundle whose products
 * are priced together — "any 3 from these for EGP 500" — instead of each
 * product on its own.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('bundles', 'mix_and_match', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('bundles', 'mix_and_match');
  },
};
