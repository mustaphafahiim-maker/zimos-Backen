'use strict';

/**
 * Card disputes and chargebacks reach the merchant (item 377,
 * payments/disputeService.js).
 *
 * payment_disputes, one row per dispute the gateway reports (Stripe
 * charge.dispute.*, PayPal CUSTOMER.DISPUTE.*), matched to the payment it
 * contests:
 *   provider_dispute_id  the gateway's id (dp_…, PP-D-…); unique per gateway
 *   status               inquiry | needs_response | under_review | won | lost | closed
 *   provider_status      the gateway's own word for it
 *   amount, currency     what the buyer contests, in minor units
 *   reason               the gateway's reason code (fraudulent, product_not_received…)
 *   evidence_due_by      the last day to answer it in the gateway's dashboard
 *   refund_id            the 'chargeback' refund written when it is lost
 *
 * refunds.source gains 'chargeback': the money a lost dispute took back, so
 * the order's refunded amount and financial state follow it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('payment_disputes', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      order_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      payment_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'payments', key: 'id' }, onDelete: 'CASCADE' },
      provider_code: { type: Sequelize.STRING(50), allowNull: false },
      provider_dispute_id: { type: Sequelize.STRING(100), allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false },
      provider_status: { type: Sequelize.STRING(60), allowNull: true },
      amount: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      currency: { type: Sequelize.STRING(3), allowNull: true },
      reason: { type: Sequelize.STRING(100), allowNull: true },
      evidence_due_by: { type: Sequelize.DATE, allowNull: true },
      opened_at: { type: Sequelize.DATE, allowNull: true },
      closed_at: { type: Sequelize.DATE, allowNull: true },
      refund_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'refunds', key: 'id' }, onDelete: 'SET NULL' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.addIndex('payment_disputes', ['provider_code', 'provider_dispute_id'], { unique: true, name: 'payment_disputes_provider_uq' });
    await queryInterface.addIndex('payment_disputes', ['workspace_id', 'status'], { name: 'payment_disputes_ws_status_idx' });
    await queryInterface.addIndex('payment_disputes', ['order_id'], { name: 'payment_disputes_order_idx' });
    await queryInterface.sequelize.query('ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_source_check;');
    await queryInterface.sequelize.query("ALTER TABLE refunds ADD CONSTRAINT refunds_source_check CHECK (source IN ('merchant', 'gateway', 'chargeback'));");
  },
  down: async (queryInterface) => {
    // Fails while a chargeback refund exists.
    await queryInterface.sequelize.query('ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_source_check;');
    await queryInterface.sequelize.query("ALTER TABLE refunds ADD CONSTRAINT refunds_source_check CHECK (source IN ('merchant', 'gateway'));");
    await queryInterface.dropTable('payment_disputes');
  },
};
