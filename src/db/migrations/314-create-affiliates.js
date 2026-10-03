'use strict';

/**
 * Affiliates (SPEC §20.3): marketers who sell the merchant's products.
 *
 *   affiliates             who they are, their `ref` code and their rate.
 *   affiliate_commissions  one row per referred order. pending until the
 *                          order is delivered, then approved; void when it
 *                          is cancelled or returned; paid once it is in a
 *                          payout.
 *   affiliate_payouts      a payment the merchant recorded by hand.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false };
    const ref = (model, onDelete = 'CASCADE', allowNull = false) => ({
      type: DataTypes.UUID,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('affiliates', {
      id,
      workspace_id: ref('workspaces'),
      name: { type: DataTypes.STRING(200), allowNull: false },
      phone_normalized: { type: DataTypes.STRING(32), allowNull: false },
      code: { type: DataTypes.STRING(40), allowNull: false },
      commission_type: { type: DataTypes.STRING(10), allowNull: false },
      // percent: basis points of the order's product subtotal. fixed: minor units per order.
      commission_value: { type: DataTypes.BIGINT, allowNull: false },
      // Empty = every product earns.
      product_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE affiliates
         ADD CONSTRAINT affiliates_commission_type_check CHECK (commission_type IN ('percent', 'fixed')),
         ADD CONSTRAINT affiliates_status_check CHECK (status IN ('active', 'paused'))`
    );
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX affiliates_ws_code_uq ON affiliates (workspace_id, LOWER(code))`);
    await queryInterface.addIndex('affiliates', ['workspace_id', 'phone_normalized'], { unique: true, name: 'affiliates_ws_phone_uq' });

    await queryInterface.createTable('affiliate_payouts', {
      id,
      workspace_id: ref('workspaces'),
      affiliate_id: ref('affiliates'),
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      method: { type: DataTypes.STRING(40), allowNull: true },
      note: { type: DataTypes.STRING(300), allowNull: true },
      paid_at: now,
      created_by: ref('users', 'SET NULL', true),
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('affiliate_payouts', ['affiliate_id', 'paid_at'], { name: 'affiliate_payouts_affiliate_idx' });

    await queryInterface.createTable('affiliate_commissions', {
      id,
      workspace_id: ref('workspaces'),
      affiliate_id: ref('affiliates'),
      order_id: ref('orders'),
      // The products' value the commission was worked out on.
      base_amount: { type: DataTypes.BIGINT, allowNull: false },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      payout_id: ref('affiliate_payouts', 'SET NULL', true),
      approved_at: { type: DataTypes.DATE, allowNull: true },
      paid_at: { type: DataTypes.DATE, allowNull: true },
      voided_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_status_check CHECK (status IN ('pending', 'approved', 'paid', 'void'))`
    );
    await queryInterface.addIndex('affiliate_commissions', ['order_id'], { unique: true, name: 'affiliate_commissions_order_uq' });
    await queryInterface.addIndex('affiliate_commissions', ['affiliate_id', 'status'], { name: 'affiliate_commissions_affiliate_idx' });
    await queryInterface.addIndex('affiliate_commissions', ['workspace_id', 'status'], { name: 'affiliate_commissions_ws_status_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('affiliate_commissions');
    await queryInterface.dropTable('affiliate_payouts');
    await queryInterface.dropTable('affiliates');
  },
};
