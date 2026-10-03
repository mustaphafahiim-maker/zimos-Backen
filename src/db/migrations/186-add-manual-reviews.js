'use strict';

/**
 * Reviews the merchant adds by hand (SPEC §7.7): real reviews that arrived
 * through another channel (WhatsApp, comments). They have no customer row, so
 * `customer_id` becomes nullable and the review carries its own author name,
 * its photos and where it came from. A manual review never shows the
 * "verified buyer" badge.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('reviews', 'customer_id', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn('reviews', 'author_name', { type: Sequelize.STRING(120), allowNull: true });
    await queryInterface.addColumn('reviews', 'photos', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addColumn('reviews', 'source', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'customer',
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Manual reviews have no customer, so they cannot survive the NOT NULL.
    await queryInterface.sequelize.query("DELETE FROM reviews WHERE customer_id IS NULL");
    await queryInterface.removeColumn('reviews', 'source');
    await queryInterface.removeColumn('reviews', 'photos');
    await queryInterface.removeColumn('reviews', 'author_name');
    await queryInterface.changeColumn('reviews', 'customer_id', { type: Sequelize.UUID, allowNull: false });
  },
};
