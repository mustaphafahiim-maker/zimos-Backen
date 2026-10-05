'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently } = require('../concurrentIndex');

/**
 * Lost orders (SPEC §6): a checkout session can now be lost for a reason —
 * a rule refused it, a bot check failed, the phone was never verified — and
 * not only by going quiet.
 *
 *   lost_reason        why the checkout did not become an order; null for a
 *                      session that is merely inactive (shown as `incomplete`)
 *   review_status      under_review | completed — whether the merchant dealt with it
 *   recovery_token     the secret of the /r/:token recovery link
 *   awaiting_otp       the shopper was sent a code and has not typed it yet
 *   checkout_payload   what the shopper submitted (contact, address, items,
 *                      payment method), so the merchant can turn it into an order
 *   ip_address / ip_country
 *   abandoned_event_at when `checkout.abandoned` was emitted for it
 *
 * The stored `status` enum is left alone: `awaiting_otp` and `lost` are
 * derived at read time (checkoutSessions/lostOrderService), like `abandoned`.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('checkout_sessions', 'lost_reason', { type: DataTypes.STRING(30), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'review_status', {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'under_review',
    });
    await queryInterface.addColumn('checkout_sessions', 'recovery_token', { type: DataTypes.STRING(64), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'awaiting_otp', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('checkout_sessions', 'checkout_payload', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'ip_address', { type: DataTypes.STRING(45), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'ip_country', { type: DataTypes.STRING(2), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'abandoned_event_at', { type: DataTypes.DATE, allowNull: true });
    await createIndexConcurrently(queryInterface, { name: 'checkout_sessions_recovery_token_uq', table: 'checkout_sessions', definition: `(recovery_token) WHERE recovery_token IS NOT NULL`, unique: true });
    await createIndexConcurrently(queryInterface, { name: 'checkout_sessions_ws_lost_reason_idx', table: 'checkout_sessions', definition: `(workspace_id, lost_reason) WHERE lost_reason IS NOT NULL` });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS checkout_sessions_ws_lost_reason_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS checkout_sessions_recovery_token_uq');
    for (const column of [
      'abandoned_event_at',
      'ip_country',
      'ip_address',
      'checkout_payload',
      'awaiting_otp',
      'recovery_token',
      'review_status',
      'lost_reason',
    ]) {
      await queryInterface.removeColumn('checkout_sessions', column);
    }
  },
};
