'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Anonymous visits to the marketing site (siteAnalytics/siteTrafficService).
 * One row per event. No IP and no long-lived identifier: visitor_hash is an
 * HMAC of a random browser id and the UTC day, so it changes every day.
 * user_id is filled when the visitor signs up in the same session.
 */
const EVENTS = ['view', 'ping', 'cta_click', 'signup'];
const DEVICES = ['mobile', 'desktop', 'tablet', 'unknown'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'site_visits',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          visitor_hash: { type: DataTypes.STRING(64), allowNull: false },
          session_id: { type: DataTypes.STRING(64), allowNull: false },
          path: { type: DataTypes.STRING(300), allowNull: true },
          locale: { type: DataTypes.STRING(5), allowNull: true },
          referrer_host: { type: DataTypes.STRING(255), allowNull: true },
          utm_source: { type: DataTypes.STRING(100), allowNull: true },
          utm_medium: { type: DataTypes.STRING(100), allowNull: true },
          utm_campaign: { type: DataTypes.STRING(100), allowNull: true },
          device_class: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'unknown' },
          country: { type: DataTypes.STRING(2), allowNull: true },
          event: { type: DataTypes.STRING(12), allowNull: false },
          seconds_on_page: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_event_check', { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE site_visits ADD CONSTRAINT site_visits_event_check CHECK (event IN (${list(EVENTS)}))`, { transaction });
      await queryInterface.sequelize.query('ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_device_class_check', { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE site_visits ADD CONSTRAINT site_visits_device_class_check CHECK (device_class IN (${list(DEVICES)}))`,
        { transaction }
      );
      await queryInterface.addIndex('site_visits', ['created_at'], { name: 'site_visits_created_at_idx', transaction });
      await queryInterface.addIndex('site_visits', ['session_id'], { name: 'site_visits_session_id_idx', transaction });
      await queryInterface.addIndex('site_visits', ['user_id'], { name: 'site_visits_user_id_idx', transaction });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('site_visits');
  },
};
