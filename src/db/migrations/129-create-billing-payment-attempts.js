'use strict';

/**
 * Paying a subscription charge online (billing/onlineBillingService).
 *
 * billing_payment_attempts: one row per checkout a merchant starts for a
 * billing invoice. The price is frozen on it when the merchant presses Pay
 * (gross, discount, amount, currency, the referral code it was priced with):
 * that is the amount the payment must match and the price the charge is
 * settled at. Statuses:
 *
 *   created         the row exists, the checkout is being asked for
 *   open            Fawaterak gave a checkout link
 *   pending         the merchant chose an async method (a Fawry reference)
 *   paid            confirmed by getTransactionData and settled the charge
 *   paid_duplicate  confirmed paid, but the charge was already paid: money
 *                   to refund by hand, the subscription is not touched again
 *   mismatch        confirmed paid with another amount or currency: not
 *                   settled, for a platform admin to decide
 *   failed | expired | superseded | error
 *                   not paid (yet); a later confirmed payment still settles
 *
 * Two partial unique indexes make the rules hold under any concurrency: one
 * attempt in progress per charge, and one attempt that paid it.
 *
 * billing_gateway_events: the inbox of verified Fawaterak webhooks, keyed
 * (provider, event_key) so a redelivery is recognised; processed_at stays
 * NULL until processing succeeded, for the sweep to retry. Webhooks whose
 * signature does not verify are never written. Signatures and customer
 * details are dropped from the payload before it is stored.
 */

const ATTEMPT_STATUSES = ['created', 'open', 'pending', 'paid', 'paid_duplicate', 'mismatch', 'failed', 'expired', 'superseded', 'error'];
const IN_PROGRESS = ['created', 'open', 'pending'];
const EVENT_KINDS = ['paid', 'failed', 'cancel', 'refund'];

const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const fk = (model, onDelete) => ({ references: { model, key: 'id' }, onDelete, onUpdate: 'CASCADE' });
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'billing_payment_attempts',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          billing_invoice_id: { type: DataTypes.UUID, allowNull: false, ...fk('billing_invoices', 'CASCADE') },
          workspace_id: { type: DataTypes.UUID, allowNull: false, ...fk('workspaces', 'CASCADE') },
          subscription_id: { type: DataTypes.UUID, allowNull: false, ...fk('subscriptions', 'CASCADE') },
          provider: { type: DataTypes.STRING(20), allowNull: false },
          status: { type: DataTypes.STRING(20), allowNull: false },
          gross_amount: { type: DataTypes.BIGINT, allowNull: false },
          discount_amount: { type: DataTypes.BIGINT, allowNull: false },
          amount: { type: DataTypes.BIGINT, allowNull: false },
          currency: { type: DataTypes.STRING(3), allowNull: false },
          referral_code_id: { type: DataTypes.UUID, allowNull: true, ...fk('referral_codes', 'SET NULL') },
          provider_intent_key: { type: DataTypes.STRING(64), allowNull: true },
          provider_transaction_id: { type: DataTypes.BIGINT, allowNull: true },
          checkout_url: { type: DataTypes.TEXT, allowNull: true },
          expires_at: { type: DataTypes.DATE, allowNull: true },
          payment_method: { type: DataTypes.STRING(100), allowNull: true },
          reference_number: { type: DataTypes.STRING(100), allowNull: true },
          verified_amount: { type: DataTypes.BIGINT, allowNull: true },
          verified_currency: { type: DataTypes.STRING(3), allowNull: true },
          paid_at: { type: DataTypes.DATE, allowNull: true },
          failure_reason: { type: DataTypes.STRING(300), allowNull: true },
          created_by_user_id: { type: DataTypes.UUID, allowNull: true, ...fk('users', 'SET NULL') },
          last_checked_at: { type: DataTypes.DATE, allowNull: true },
          check_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE billing_payment_attempts
           ADD CONSTRAINT billing_payment_attempts_status_check CHECK (status IN (${list(ATTEMPT_STATUSES)})),
           ADD CONSTRAINT billing_payment_attempts_amounts_check CHECK (
             amount > 0 AND discount_amount >= 0 AND amount = gross_amount - discount_amount
           ),
           ADD CONSTRAINT billing_payment_attempts_currency_check CHECK (currency ~ '^[A-Z]{3}$')`,
        { transaction }
      );
      await queryInterface.addIndex('billing_payment_attempts', ['provider_intent_key'], {
        name: 'billing_payment_attempts_intent_key_idx',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('billing_payment_attempts', ['provider', 'provider_transaction_id'], {
        name: 'billing_payment_attempts_transaction_idx',
        unique: true,
        where: { provider_transaction_id: { [Sequelize.Op.ne]: null } },
        transaction,
      });
      await queryInterface.addIndex('billing_payment_attempts', ['billing_invoice_id'], {
        name: 'billing_payment_attempts_one_in_progress_idx',
        unique: true,
        where: { status: IN_PROGRESS },
        transaction,
      });
      await queryInterface.addIndex('billing_payment_attempts', ['billing_invoice_id'], {
        name: 'billing_payment_attempts_one_paid_idx',
        unique: true,
        where: { status: 'paid' },
        transaction,
      });
      await queryInterface.addIndex('billing_payment_attempts', ['workspace_id', 'created_at'], {
        name: 'billing_payment_attempts_workspace_idx',
        transaction,
      });
      await queryInterface.addIndex('billing_payment_attempts', ['status', 'last_checked_at'], {
        name: 'billing_payment_attempts_sweep_idx',
        transaction,
      });

      await queryInterface.createTable(
        'billing_gateway_events',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          provider: { type: DataTypes.STRING(20), allowNull: false },
          kind: { type: DataTypes.STRING(20), allowNull: false },
          event_key: { type: DataTypes.STRING(200), allowNull: false },
          attempt_id: { type: DataTypes.UUID, allowNull: true, ...fk('billing_payment_attempts', 'SET NULL') },
          payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          processed_at: { type: DataTypes.DATE, allowNull: true },
          outcome: { type: DataTypes.STRING(40), allowNull: true },
          error: { type: DataTypes.STRING(500), allowNull: true },
          attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE billing_gateway_events
           ADD CONSTRAINT billing_gateway_events_kind_check CHECK (kind IN (${list(EVENT_KINDS)}))`,
        { transaction }
      );
      await queryInterface.addIndex('billing_gateway_events', ['provider', 'event_key'], {
        name: 'billing_gateway_events_key_idx',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('billing_gateway_events', ['attempt_id'], {
        name: 'billing_gateway_events_attempt_idx',
        transaction,
      });
      await queryInterface.addIndex('billing_gateway_events', ['created_at'], {
        name: 'billing_gateway_events_unprocessed_idx',
        where: { processed_at: null },
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('billing_gateway_events', { transaction });
      await queryInterface.dropTable('billing_payment_attempts', { transaction });
    });
  },
};
