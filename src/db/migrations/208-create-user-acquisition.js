'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Where an account came from (siteAnalytics/siteTrafficService.linkSignup):
 * the first marketing-site visit of the session it signed up from, kept once
 * per account. Written only while site analytics is on.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'user_acquisition',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
          session_id: { type: DataTypes.STRING(64), allowNull: false },
          landing_path: { type: DataTypes.STRING(300), allowNull: true },
          referrer_host: { type: DataTypes.STRING(255), allowNull: true },
          utm_source: { type: DataTypes.STRING(100), allowNull: true },
          utm_medium: { type: DataTypes.STRING(100), allowNull: true },
          utm_campaign: { type: DataTypes.STRING(100), allowNull: true },
          first_visit_at: { type: DataTypes.DATE, allowNull: false },
          signed_up_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.addIndex('user_acquisition', ['user_id'], { name: 'user_acquisition_user_id_unique', unique: true, transaction });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('user_acquisition');
  },
};
