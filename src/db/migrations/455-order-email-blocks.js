'use strict';

/**
 * An order email built with the block designer (notifications/emailBlocks.js):
 * the blocks as JSON; null = the plain subject + body.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('order_email_templates', 'blocks', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('order_email_templates', 'blocks');
  },
};
