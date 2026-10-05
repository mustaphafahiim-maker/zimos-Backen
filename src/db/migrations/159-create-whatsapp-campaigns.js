'use strict';

const { guarded } = require('../migrationGuards');

/**
 * WhatsApp campaigns (SPEC §14.4): one approved marketing template sent to a
 * list of contacts who agreed to marketing.
 *
 *   whatsapp_campaigns             the campaign, its audience, pace and state
 *   whatsapp_campaign_recipients   one row per person, fixed when it starts
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const workspace = { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' };
    const timestamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    };

    await queryInterface.createTable('whatsapp_campaigns', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: workspace,
      name: { type: DataTypes.STRING(150), allowNull: false },
      // draft | scheduled | sending | paused | completed | cancelled
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      // { type: 'all' | 'segment' | 'list', segmentId?, rows?: [{ name, phone }] }
      audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      template_name: { type: DataTypes.STRING(200), allowNull: false },
      template_language: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ar' },
      template_params: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      coupon_code: { type: DataTypes.STRING(100), allowNull: true },
      daily_cap: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 250 },
      scheduled_at: { type: DataTypes.DATE, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      pause_reason: { type: DataTypes.STRING(300), allowNull: true },
      // Fixed when the campaign starts: how many were in the audience, and how many of them had not agreed to marketing.
      audience_size: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      excluded_no_consent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_by_user_id: { type: DataTypes.UUID, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('whatsapp_campaigns', ['workspace_id', 'created_at'], { name: 'whatsapp_campaigns_workspace_idx' });

    await queryInterface.createTable('whatsapp_campaign_recipients', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      campaign_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'whatsapp_campaigns', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      workspace_id: workspace,
      customer_id: { type: DataTypes.UUID, allowNull: true },
      phone_normalized: { type: DataTypes.STRING(32), allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: true },
      // pending | sent | failed | skipped
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      wa_message_id: { type: DataTypes.STRING(200), allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      sent_at: { type: DataTypes.DATE, allowNull: true },
      replied_at: { type: DataTypes.DATE, allowNull: true },
      unsubscribed_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('whatsapp_campaign_recipients', ['campaign_id', 'phone_normalized'], { name: 'whatsapp_campaign_recipients_unique_idx', unique: true });
    await queryInterface.addIndex('whatsapp_campaign_recipients', ['campaign_id', 'status'], { name: 'whatsapp_campaign_recipients_status_idx' });
    await queryInterface.addIndex('whatsapp_campaign_recipients', ['workspace_id', 'phone_normalized', 'sent_at'], { name: 'whatsapp_campaign_recipients_phone_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('whatsapp_campaign_recipients');
    await queryInterface.dropTable('whatsapp_campaigns');
  },
};
