'use strict';

/** The owner's picture (SPEC §17.3 "account name, picture"): a public image URL from the media library. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'avatar_url', { type: Sequelize.DataTypes.STRING(1000), allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'avatar_url');
  },
};
