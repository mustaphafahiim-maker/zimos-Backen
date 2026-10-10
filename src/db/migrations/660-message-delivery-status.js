'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Delivery status for customer emails and SMS (notifications/deliveryStatus,
 * DELIVERY_STATUS_ENABLED).
 *
 * notification_logs:
 *   provider_message_id  the id the provider gave the message (Brevo's
 *                        message-id without its angle brackets, Twilio's
 *                        MessageSid, `console-…` for the console provider);
 *                        status webhooks find the row by it
 *   delivery_status      what the provider reported after the send:
 *                        delivered / bounced / complained / undelivered, or
 *                        suppressed (not sent: the address is on the list).
 *                        VARCHAR + CHECK beside `status` (sent / failed at
 *                        send time), whose enum is left as it is
 *   status_at            when the provider reported it
 *   status_reason        what it said (a bounce reason, a Twilio error code)
 *
 * email_suppressions: addresses no email goes to any more, per store
 * (workspace_id) or for the platform's own emails (workspace_id null):
 *   reason  hard_bounce | complaint      source  brevo | twilio | console
 * One row per scope and address (lower-cased); lifting deletes the row.
 *
 * Additive and run-twice safe. On notification_logs (a big table): nullable
 * columns, the CHECK added NOT VALID then validated (no long lock), the index
 * built CONCURRENTLY by the guard.
 */
const STATUSES = ['delivered', 'bounced', 'complained', 'undelivered', 'suppressed'];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    await qi.addColumn('notification_logs', 'provider_message_id', { type: Sequelize.STRING(255), allowNull: true });
    await qi.addColumn('notification_logs', 'delivery_status', { type: Sequelize.STRING(20), allowNull: true });
    await qi.addColumn('notification_logs', 'status_at', { type: Sequelize.DATE, allowNull: true });
    await qi.addColumn('notification_logs', 'status_reason', { type: Sequelize.STRING(300), allowNull: true });
    const [[has]] = await sequelize.query("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'notification_logs_delivery_status_check'");
    if (!has.n) {
      await sequelize.query(`ALTER TABLE notification_logs ADD CONSTRAINT notification_logs_delivery_status_check CHECK (delivery_status IS NULL OR delivery_status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})) NOT VALID`);
      await sequelize.query('ALTER TABLE notification_logs VALIDATE CONSTRAINT notification_logs_delivery_status_check');
    }
    await qi.addIndex('notification_logs', ['provider', 'provider_message_id'], { name: 'notification_logs_provider_message_idx', where: { provider_message_id: { [Sequelize.Op.ne]: null } } });

    const created = await qi.createTable('email_suppressions', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      email: { type: Sequelize.STRING(255), allowNull: false },
      // hard_bounce | complaint
      reason: { type: Sequelize.STRING(20), allowNull: false },
      source: { type: Sequelize.STRING(30), allowNull: false },
      detail: { type: Sequelize.STRING(300), allowNull: true },
      notification_log_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    if (created) await sequelize.query("ALTER TABLE email_suppressions ADD CONSTRAINT email_suppressions_reason_check CHECK (reason IN ('hard_bounce', 'complaint'))");
    await sequelize.query("CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_scope_email_uq ON email_suppressions ((COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), email)");
    await qi.addIndex('email_suppressions', ['workspace_id', 'created_at'], { name: 'email_suppressions_ws_created_idx' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.dropTable('email_suppressions');
    await qi.removeIndex('notification_logs', 'notification_logs_provider_message_idx');
    await queryInterface.sequelize.query('ALTER TABLE notification_logs DROP CONSTRAINT IF EXISTS notification_logs_delivery_status_check');
    await qi.removeColumn('notification_logs', 'status_reason');
    await qi.removeColumn('notification_logs', 'status_at');
    await qi.removeColumn('notification_logs', 'delivery_status');
    await qi.removeColumn('notification_logs', 'provider_message_id');
  },
};
