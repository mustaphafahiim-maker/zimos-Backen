'use strict';

/**
 * Order emails per funnel or website (notifications/orderEmailService.js):
 * `scope` is '' for the store's own set, 'funnel:<id>' or 'website:<id>' for
 * an override. The unique key becomes (workspace, key, scope).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('order_email_templates', 'scope', { type: Sequelize.STRING(80), allowNull: false, defaultValue: '' });
    await queryInterface.removeIndex('order_email_templates', 'order_email_templates_workspace_key_idx');
    await queryInterface.addIndex('order_email_templates', ['workspace_id', 'key', 'scope'], { unique: true, name: 'order_email_templates_workspace_key_scope_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query("DELETE FROM order_email_templates WHERE scope <> ''");
    await queryInterface.removeIndex('order_email_templates', 'order_email_templates_workspace_key_scope_idx');
    await queryInterface.addIndex('order_email_templates', ['workspace_id', 'key'], { unique: true, name: 'order_email_templates_workspace_key_idx' });
    await queryInterface.removeColumn('order_email_templates', 'scope');
  },
};
