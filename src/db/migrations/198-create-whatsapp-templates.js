'use strict';

const { guarded } = require('../migrationGuards');

/**
 * whatsapp_templates (SPEC §14.1 "syncing templates and their status"): the
 * message templates of the store's own WhatsApp Business account, as Meta
 * has them — name, language, category, status, the body text and its
 * placeholder count. Synced from the Graph API on demand and on connect, and
 * kept current by Meta's message_template_status_update webhook
 * (whatsapp/whatsappTemplates.js). One row per (name, language).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('whatsapp_templates', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      meta_id: { type: DataTypes.STRING(64), allowNull: true },
      name: { type: DataTypes.STRING(512), allowNull: false },
      language: { type: DataTypes.STRING(15), allowNull: false },
      // MARKETING | UTILITY | AUTHENTICATION
      category: { type: DataTypes.STRING(30), allowNull: true },
      // APPROVED | PENDING | REJECTED | PAUSED | DISABLED | IN_APPEAL | … as Meta says
      status: { type: DataTypes.STRING(30), allowNull: false },
      rejected_reason: { type: DataTypes.STRING(200), allowNull: true },
      body_text: { type: DataTypes.TEXT, allowNull: true },
      // How many {{n}} placeholders the body has: the params a send must fill.
      params_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      components: { type: DataTypes.JSONB, allowNull: true },
      synced_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('whatsapp_templates', ['workspace_id', 'name', 'language'], { unique: true, name: 'whatsapp_templates_ws_name_lang_uniq' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('whatsapp_templates');
  },
};
