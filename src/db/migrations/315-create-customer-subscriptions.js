'use strict';

/**
 * Subscriptions and installments (SPEC §18.1).
 *
 *   products.billing_plan    null = sold once. Otherwise
 *                            { mode: 'subscription', interval, intervalCount }
 *                            or { mode: 'installments', interval, intervalCount, payments }.
 *                            The variant's price is what each payment charges.
 *   customer_subscriptions   one per order line bought on a plan: the saved
 *                            card it renews on, its period, what is left.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const ref = (model, onDelete = 'CASCADE', allowNull = false) => ({
      type: DataTypes.UUID,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    await queryInterface.addColumn('products', 'billing_plan', { type: DataTypes.JSONB, allowNull: true });

    await queryInterface.createTable('customer_subscriptions', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: ref('workspaces'),
      customer_id: ref('customers'),
      product_id: ref('products', 'SET NULL', true),
      variant_id: ref('product_variants', 'SET NULL', true),
      product_name: { type: DataTypes.STRING(300), allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // The order that started it, and its line.
      order_id: ref('orders'),
      order_item_id: ref('order_items'),
      last_order_id: ref('orders', 'SET NULL', true),
      kind: { type: DataTypes.STRING(15), allowNull: false },
      status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'active' },
      interval: { type: DataTypes.STRING(10), allowNull: false },
      interval_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      saved_payment_method_id: ref('payment_methods_saved', 'SET NULL', true),
      current_period_start: { type: DataTypes.DATE, allowNull: false },
      current_period_end: { type: DataTypes.DATE, allowNull: false },
      // When the next charge is tried: the period end, or a retry date after a failure.
      next_renewal_at: { type: DataTypes.DATE, allowNull: true },
      payments_made: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // Installments only.
      installments_total: { type: DataTypes.INTEGER, allowNull: true },
      installments_remaining: { type: DataTypes.INTEGER, allowNull: true },
      failed_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_failure_reason: { type: DataTypes.STRING(300), allowNull: true },
      portal_token: { type: DataTypes.STRING(64), allowNull: false },
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      cancel_reason: { type: DataTypes.STRING(300), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_subscriptions
         ADD CONSTRAINT customer_subscriptions_kind_check CHECK (kind IN ('subscription', 'installments')),
         ADD CONSTRAINT customer_subscriptions_status_check CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'completed')),
         ADD CONSTRAINT customer_subscriptions_interval_check CHECK (interval IN ('week', 'month', 'year'))`
    );
    await queryInterface.addIndex('customer_subscriptions', ['order_item_id'], { unique: true, name: 'customer_subscriptions_order_item_uq' });
    await queryInterface.addIndex('customer_subscriptions', ['portal_token'], { unique: true, name: 'customer_subscriptions_token_uq' });
    await queryInterface.addIndex('customer_subscriptions', ['status', 'next_renewal_at'], { name: 'customer_subscriptions_due_idx' });
    await queryInterface.addIndex('customer_subscriptions', ['workspace_id', 'created_at'], { name: 'customer_subscriptions_ws_created_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('customer_subscriptions');
    await queryInterface.removeColumn('products', 'billing_plan');
  },
};
