'use strict';

/**
 * The online payments ledger (item 384, modules/payments/ledger):
 *
 *   gateway_payouts   one row per payout a gateway sent to the merchant's bank
 *       (adapter `listPayouts`, a daily job per connected account): its amount,
 *       currency, the fees of what it holds, arrival date and status, and how
 *       many of its lines matched nothing in ZIMOS.
 *   payments.fee_amount / net_amount / fee_currency   what the gateway kept and
 *       what reached the balance, in the gateway's settlement currency (adapter
 *       `fetchFees` after capture, or the payout's lines); null = not known yet.
 *   payments.fees_checked_at   when the gateway was last asked (the job's backoff).
 *   payments.payout_id, refunds.payout_id   the payout that carried them.
 *   refunds.fee_amount / net_amount / fee_currency   the same for a refund (from
 *       the payout's lines; null = not known yet).
 *   payment_gateway_accounts.payouts_synced_at   the account's last payout sync.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('gateway_payouts', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      provider_code: { type: Sequelize.STRING(50), allowNull: false },
      mode: { type: Sequelize.STRING(10), allowNull: true },
      external_id: { type: Sequelize.STRING(100), allowNull: false },
      amount: { type: Sequelize.BIGINT, allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      fee_amount: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      arrival_date: { type: Sequelize.DATEONLY, allowNull: true },
      // pending | in_transit | paid | failed | canceled
      status: { type: Sequelize.STRING(20), allowNull: false },
      unmatched_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      unmatched_amount: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      synced_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.addIndex('gateway_payouts', ['workspace_id', 'provider_code', 'external_id'], { unique: true, name: 'gateway_payouts_external_idx' });
    await queryInterface.addIndex('gateway_payouts', ['workspace_id', 'arrival_date'], { name: 'gateway_payouts_arrival_idx' });

    const payout = { type: Sequelize.UUID, allowNull: true, references: { model: 'gateway_payouts', key: 'id' }, onDelete: 'SET NULL' };
    await queryInterface.addColumn('payments', 'fee_amount', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.addColumn('payments', 'net_amount', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.addColumn('payments', 'fee_currency', { type: Sequelize.STRING(3), allowNull: true });
    await queryInterface.addColumn('payments', 'fees_checked_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('payments', 'payout_id', payout);
    await queryInterface.addColumn('refunds', 'fee_amount', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.addColumn('refunds', 'net_amount', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.addColumn('refunds', 'fee_currency', { type: Sequelize.STRING(3), allowNull: true });
    await queryInterface.addColumn('refunds', 'payout_id', payout);
    await queryInterface.addColumn('payment_gateway_accounts', 'payouts_synced_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addIndex('payments', ['payout_id'], { name: 'payments_payout_idx' });
    await queryInterface.addIndex('refunds', ['payout_id'], { name: 'refunds_payout_idx' });
    // The ledger reads a store's gateway payments by when they were paid.
    await queryInterface.addIndex('payments', ['workspace_id', 'paid_at'], { name: 'payments_workspace_paid_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.removeIndex('payments', 'payments_workspace_paid_idx');
    await queryInterface.removeIndex('refunds', 'refunds_payout_idx');
    await queryInterface.removeIndex('payments', 'payments_payout_idx');
    await queryInterface.removeColumn('payment_gateway_accounts', 'payouts_synced_at');
    await queryInterface.removeColumn('refunds', 'payout_id');
    await queryInterface.removeColumn('refunds', 'fee_currency');
    await queryInterface.removeColumn('refunds', 'net_amount');
    await queryInterface.removeColumn('refunds', 'fee_amount');
    await queryInterface.removeColumn('payments', 'payout_id');
    await queryInterface.removeColumn('payments', 'fees_checked_at');
    await queryInterface.removeColumn('payments', 'fee_currency');
    await queryInterface.removeColumn('payments', 'net_amount');
    await queryInterface.removeColumn('payments', 'fee_amount');
    await queryInterface.dropTable('gateway_payouts');
  },
};
