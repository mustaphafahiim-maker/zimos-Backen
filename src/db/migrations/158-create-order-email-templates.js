'use strict';

const { guarded } = require('../migrationGuards');

/**
 * order_email_templates (SPEC §14.5): what a store changed about the emails
 * its customers get about their orders. One row per store per template key,
 * written only when the merchant switches a template on or edits it — a store
 * with no row uses the built-in Arabic text and sends nothing (the templates
 * start switched off). See modules/notifications/orderEmailService.js.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('order_email_templates', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      key: { type: DataTypes.STRING(40), allowNull: false },
      is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Null = the built-in text.
      subject: { type: DataTypes.STRING(200), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('order_email_templates', ['workspace_id', 'key'], { name: 'order_email_templates_workspace_key_idx', unique: true });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('order_email_templates');
  },
};
