'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Gift cards (modules/giftCards, STORE_FEATURES gift_cards).
 *
 * - gift_cards: a code (looked up by its HMAC, kept sealed so staff can
 *   resend it, shown as its last 4), its value and what is left, currency,
 *   expiry, who it is for, and where it came from (issued by staff, or sold
 *   as a product on an order line).
 * - gift_card_transactions: every change of a balance — issue, redeem on an
 *   order, refund back, adjust — so the balance can always be explained.
 *
 * New tables, skipped when present; status, source and kind are VARCHAR + CHECK.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const cards = await qi.createTable('gift_cards', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      code_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      code_sealed: { type: Sequelize.TEXT, allowNull: false },
      last4: { type: Sequelize.STRING(4), allowNull: false },
      initial_amount: { type: Sequelize.BIGINT, allowNull: false },
      balance_amount: { type: Sequelize.BIGINT, allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      // active | disabled (expired and empty are worked out, not stored)
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active' },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      // manual | order
      source: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'manual' },
      order_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'orders', key: 'id' }, onDelete: 'SET NULL' },
      order_item_id: { type: Sequelize.UUID, allowNull: true },
      unit_index: { type: Sequelize.INTEGER, allowNull: true },
      customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL' },
      recipient_name: { type: Sequelize.STRING(200), allowNull: true },
      recipient_email: { type: Sequelize.STRING(255), allowNull: true },
      message: { type: Sequelize.STRING(500), allowNull: true },
      note: { type: Sequelize.STRING(500), allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (cards) {
      await queryInterface.sequelize.query("ALTER TABLE gift_cards ADD CONSTRAINT gift_cards_status_check CHECK (status IN ('active', 'disabled'))");
      await queryInterface.sequelize.query("ALTER TABLE gift_cards ADD CONSTRAINT gift_cards_source_check CHECK (source IN ('manual', 'order'))");
      await queryInterface.sequelize.query('ALTER TABLE gift_cards ADD CONSTRAINT gift_cards_balance_check CHECK (balance_amount >= 0)');
    }
    await qi.addIndex('gift_cards', ['workspace_id', 'created_at'], { name: 'gift_cards_ws_idx' });
    // One card per sold unit of an order line: issuing twice is a no-op.
    await qi.addIndex('gift_cards', ['order_item_id', 'unit_index'], { name: 'gift_cards_order_unit_unique', unique: true, where: { order_item_id: { [Sequelize.Op.ne]: null } } });

    const txs = await qi.createTable('gift_card_transactions', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      gift_card_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'gift_cards', key: 'id' }, onDelete: 'CASCADE' },
      // issue | redeem | refund | adjust
      kind: { type: Sequelize.STRING(20), allowNull: false },
      amount: { type: Sequelize.BIGINT, allowNull: false },
      balance_after: { type: Sequelize.BIGINT, allowNull: false },
      // No foreign key: a refund credits the card while the order row is locked by that refund.
      order_id: { type: Sequelize.UUID, allowNull: true },
      payment_id: { type: Sequelize.UUID, allowNull: true },
      note: { type: Sequelize.STRING(300), allowNull: true },
      actor_user_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (txs) {
      await queryInterface.sequelize.query("ALTER TABLE gift_card_transactions ADD CONSTRAINT gift_card_transactions_kind_check CHECK (kind IN ('issue', 'redeem', 'refund', 'adjust'))");
    }
    await qi.addIndex('gift_card_transactions', ['gift_card_id', 'created_at'], { name: 'gift_card_tx_card_idx' });
    await qi.addIndex('gift_card_transactions', ['order_id'], { name: 'gift_card_tx_order_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('gift_card_transactions');
    await queryInterface.dropTable('gift_cards');
  },
};
