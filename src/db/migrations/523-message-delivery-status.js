'use strict';

/**
 * Delivery status for customer emails and SMS (spec-gaps item 386).
 *
 * notification_logs:
 *   provider_message_id  the id the provider gave the message (Brevo's
 *                        message-id without its angle brackets, Twilio's
 *                        MessageSid, `console-…` for the console provider);
 *                        status webhooks find the row by it
 *   status               gains delivered / bounced / complained / undelivered
 *                        (from the provider's webhook) and suppressed (not
 *                        sent: the address is on the suppression list)
 *   status_at            when the provider reported the latest status
 *   status_reason        what it said (a bounce reason, a Twilio error code)
 *
 * email_suppressions: addresses no email goes to any more, per store
 * (workspace_id) or for the platform's own emails (workspace_id null):
 *   reason  hard_bounce | complaint      source  brevo | console | …
 * One row per scope and address (lower-cased); lifting deletes the row.
 *
 * Adding enum values is safe on a live table (ADD VALUE IF NOT EXISTS, no
 * rewrite). Postgres cannot drop an enum value, so down maps the new statuses
 * back to sent / failed and leaves the values in the type, unused.
 */
const NEW_STATUSES = ['delivered', 'bounced', 'complained', 'undelivered', 'suppressed'];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    for (const value of NEW_STATUSES) {
      await queryInterface.sequelize.query(`ALTER TYPE enum_notification_logs_status ADD VALUE IF NOT EXISTS '${value}'`);
    }
    await queryInterface.addColumn('notification_logs', 'provider_message_id', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn('notification_logs', 'status_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('notification_logs', 'status_reason', { type: Sequelize.STRING(300), allowNull: true });
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS notification_logs_provider_message_idx ON notification_logs (provider, provider_message_id) WHERE provider_message_id IS NOT NULL'
    );

    await queryInterface.createTable('email_suppressions', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      email: { type: Sequelize.STRING(255), allowNull: false },
      reason: { type: Sequelize.STRING(20), allowNull: false },
      source: { type: Sequelize.STRING(30), allowNull: false },
      detail: { type: Sequelize.STRING(300), allowNull: true },
      notification_log_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.sequelize.query(
      "CREATE UNIQUE INDEX email_suppressions_scope_email_uq ON email_suppressions (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), email)"
    );
    await queryInterface.addIndex('email_suppressions', ['workspace_id', 'created_at'], { name: 'email_suppressions_ws_created_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('email_suppressions');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS notification_logs_provider_message_idx');
    await queryInterface.sequelize.query("UPDATE notification_logs SET status = 'failed' WHERE status = 'suppressed'");
    await queryInterface.sequelize.query("UPDATE notification_logs SET status = 'sent' WHERE status IN ('delivered', 'bounced', 'complained', 'undelivered')");
    await queryInterface.removeColumn('notification_logs', 'status_reason');
    await queryInterface.removeColumn('notification_logs', 'status_at');
    await queryInterface.removeColumn('notification_logs', 'provider_message_id');
  },
};
