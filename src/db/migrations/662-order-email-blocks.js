'use strict';

const { guarded } = require('../migrationGuards');

/**
 * An order email built with the block designer (notifications/emailBlocks.js,
 * STORE_FEATURES email_blocks): the blocks as JSON; null = the plain subject
 * + body. Additive and run-twice safe: one nullable column.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('order_email_templates', 'blocks', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('order_email_templates', 'blocks');
  },
};
