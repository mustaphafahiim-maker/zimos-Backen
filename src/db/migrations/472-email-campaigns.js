'use strict';

/**
 * Email campaigns (modules/emailCampaigns, spec-gaps item 200): a broadcast
 * built with the block designer to the store's consenting contacts (a segment
 * or tag of them), sent now or at a set time, with its recipients kept for
 * the sent / opened counts and the unsubscribe link.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const ts = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    };
    await queryInterface.createTable('email_campaigns', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      subject: { type: Sequelize.STRING(200), allowNull: false },
      blocks: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      // { segmentId, tag } — both optional; always consenting contacts only.
      audience: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      // draft | scheduled | sending | sent | cancelled
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'draft' },
      scheduled_at: { type: Sequelize.DATE, allowNull: true },
      started_at: { type: Sequelize.DATE, allowNull: true },
      sent_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      ...ts,
    });
    await queryInterface.addIndex('email_campaigns', ['workspace_id', 'created_at'], { name: 'email_campaigns_ws_idx' });
    await queryInterface.addIndex('email_campaigns', ['status', 'scheduled_at'], { name: 'email_campaigns_due_idx' });

    await queryInterface.createTable('email_campaign_recipients', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      campaign_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'email_campaigns', key: 'id' }, onDelete: 'CASCADE' },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL' },
      email: { type: Sequelize.STRING(255), allowNull: false },
      full_name: { type: Sequelize.STRING(200), allowNull: true },
      // queued | sent | failed | skipped
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'queued' },
      error: { type: Sequelize.STRING(300), allowNull: true },
      sent_at: { type: Sequelize.DATE, allowNull: true },
      opened_at: { type: Sequelize.DATE, allowNull: true },
      ...ts,
    });
    await queryInterface.addIndex('email_campaign_recipients', ['campaign_id', 'email'], { name: 'email_campaign_recipients_uq', unique: true });
    await queryInterface.addIndex('email_campaign_recipients', ['campaign_id', 'status'], { name: 'email_campaign_recipients_status_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('email_campaign_recipients');
    await queryInterface.dropTable('email_campaigns');
  },
};
