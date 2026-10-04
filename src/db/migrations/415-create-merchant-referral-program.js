'use strict';

/**
 * ZIMOS's own referral program for merchants (SPEC §20.4): a merchant shares
 * a link with their code and earns a share of what the stores they brought in
 * pay ZIMOS. The share is an open decision, so it is a platform setting, not
 * code: `platform_settings` holds it (key `merchant_referral_program`,
 * { open, rateBp }), set from the platform console.
 *
 * A merchant's code is an ordinary referral_codes row owned by them, so the
 * existing commission ledger (agent_commissions) records their earnings.
 * `referral_payout_requests` is the merchant asking to be paid what is owed;
 * the console pays it by hand (Vodafone Cash, InstaPay, bank) and marks it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'platform_settings',
        {
          key: { type: DataTypes.STRING(100), primaryKey: true, allowNull: false },
          value: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          updated_by: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        },
        { transaction }
      );
      await queryInterface.createTable(
        'referral_payout_requests',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
          // What was owed when asked, per currency: [{ currency, amount }] in minor units.
          amounts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
          // vodafone_cash | instapay | bank_transfer
          method: { type: DataTypes.STRING(20), allowNull: false },
          details: { type: DataTypes.STRING(300), allowNull: false },
          // requested | paid | rejected
          status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'requested' },
          note: { type: DataTypes.STRING(500), allowNull: true },
          handled_by: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
          handled_at: { type: DataTypes.DATE, allowNull: true },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        },
        { transaction }
      );
      await queryInterface.addIndex('referral_payout_requests', ['user_id', 'created_at'], { name: 'referral_payout_requests_user_idx', transaction });
      await queryInterface.addIndex('referral_payout_requests', ['status'], { name: 'referral_payout_requests_status_idx', transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('referral_payout_requests', { transaction });
      await queryInterface.dropTable('platform_settings', { transaction });
    });
  },
};
