'use strict';

/** Shoppers inviting friends (modules/customerReferrals, spec-gaps item 222). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('customer_referral_codes', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      code: { type: Sequelize.STRING(16), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('customer_referral_codes', ['workspace_id', 'code'], { name: 'customer_referral_codes_code_uq', unique: true });
    await queryInterface.addIndex('customer_referral_codes', ['customer_id'], { name: 'customer_referral_codes_customer_uq', unique: true });

    await queryInterface.createTable('customer_referrals', {
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
    await queryInterface.addIndex('customer_referrals', ['order_id'], { name: 'customer_referrals_order_uq', unique: true });
    await queryInterface.addIndex('customer_referrals', ['workspace_id', 'referrer_customer_id', 'status'], { name: 'customer_referrals_referrer_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('customer_referrals');
    await queryInterface.dropTable('customer_referral_codes');
  },
};
