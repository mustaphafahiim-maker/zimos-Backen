'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Shoppers inviting friends (modules/customerReferrals, STORE_FEATURES
 * customer_referrals): a code per shopper, and one row per friend's first
 * order placed with it (status pending | rewarded | void, VARCHAR + CHECK).
 *
 * The referrer's reward is store credit or points: the two ledgers' kind
 * CHECKs (migrations 680, 681) gain `referral`. Additive and run-twice safe.
 */
const LOYALTY_KINDS = ['earn', 'redeem', 'refund', 'reverse', 'expire', 'adjust'];
const CREDIT_KINDS = ['grant', 'refund_credit', 'redeem', 'refund', 'adjust'];
const list = (kinds) => kinds.map((k) => `'${k}'`).join(', ');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.createTable('customer_referral_codes', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      code: { type: Sequelize.STRING(16), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await qi.addIndex('customer_referral_codes', ['workspace_id', 'code'], { name: 'customer_referral_codes_code_uq', unique: true });
    await qi.addIndex('customer_referral_codes', ['customer_id'], { name: 'customer_referral_codes_customer_uq', unique: true });
    const created = await qi.createTable('customer_referrals', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      referrer_customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      friend_customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL' },
      order_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      // pending (friend's order not delivered yet) | rewarded | void
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'pending' },
      // What the friend got: { percentOff, freeShipping }
      friend_offer: { type: Sequelize.JSONB, allowNull: true },
      // What the referrer got: { type: 'store_credit' | 'points', amount }
      reward: { type: Sequelize.JSONB, allowNull: true },
      void_reason: { type: Sequelize.STRING(40), allowNull: true },
      rewarded_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (created) await queryInterface.sequelize.query("ALTER TABLE customer_referrals ADD CONSTRAINT customer_referrals_status_check CHECK (status IN ('pending', 'rewarded', 'void'))");
    await qi.addIndex('customer_referrals', ['order_id'], { name: 'customer_referrals_order_uq', unique: true });
    await qi.addIndex('customer_referrals', ['workspace_id', 'referrer_customer_id', 'status'], { name: 'customer_referrals_referrer_idx' });

    // The reward lands in either ledger as `referral`.
    await queryInterface.sequelize.query('ALTER TABLE loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_kind_check');
    await queryInterface.sequelize.query(`ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_kind_check CHECK (kind IN (${list([...LOYALTY_KINDS, 'referral'])}))`);
    await queryInterface.sequelize.query('ALTER TABLE store_credit_transactions DROP CONSTRAINT IF EXISTS store_credit_transactions_kind_check');
    await queryInterface.sequelize.query(`ALTER TABLE store_credit_transactions ADD CONSTRAINT store_credit_transactions_kind_check CHECK (kind IN (${list([...CREDIT_KINDS, 'referral'])}))`);
  },
  down: async (queryInterface) => {
    // The narrow CHECKs come back for new rows only (NOT VALID): referral rows already written stay.
    await queryInterface.sequelize.query('ALTER TABLE loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_kind_check');
    await queryInterface.sequelize.query(`ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_kind_check CHECK (kind IN (${list(LOYALTY_KINDS)})) NOT VALID`);
    await queryInterface.sequelize.query('ALTER TABLE store_credit_transactions DROP CONSTRAINT IF EXISTS store_credit_transactions_kind_check');
    await queryInterface.sequelize.query(`ALTER TABLE store_credit_transactions ADD CONSTRAINT store_credit_transactions_kind_check CHECK (kind IN (${list(CREDIT_KINDS)})) NOT VALID`);
    await queryInterface.dropTable('customer_referrals');
    await queryInterface.dropTable('customer_referral_codes');
  },
};
