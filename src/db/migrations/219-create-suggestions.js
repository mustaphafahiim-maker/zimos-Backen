'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Suggestions (modules/suggestions): a merchant's ideas, bug reports and
 * improvements, answered from the console.
 *
 *  - suggestions   title, description, category feature|bug|improvement,
 *                  optional contact, status new|under_review|planned|done
 *                  (VARCHAR + CHECK), the admin's reply and who wrote it
 *
 * It also lets the console notify about a new one: the type 'suggestion' is
 * added to the CHECKs of platform_notifications and platform_notification_prefs
 * (migration 206). Those CHECKs are read and extended rather than rewritten,
 * so a type another migration added is kept; down() takes 'suggestion' out
 * again (after deleting its rows).
 */
const CATEGORIES = ['feature', 'bug', 'improvement'];
const STATUSES = ['new', 'under_review', 'planned', 'done'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');
const NOTIFICATION_CHECKS = [
  ['platform_notifications', 'platform_notifications_type_check'],
  ['platform_notification_prefs', 'platform_notification_prefs_type_check'],
];

async function notificationTypes(queryInterface, name, transaction) {
  const [rows] = await queryInterface.sequelize.query('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = :name', {
    replacements: { name },
    transaction,
  });
  if (rows.length === 0) return null;
  return [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

async function setNotificationTypes(queryInterface, change, transaction) {
  for (const [table, name] of NOTIFICATION_CHECKS) {
    const current = await notificationTypes(queryInterface, name, transaction);
    if (!current) continue;
    const next = change(current);
    if (next.length === current.length && next.every((t) => current.includes(t))) continue;
    await queryInterface.sequelize.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`, { transaction });
    await queryInterface.sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (type IN (${list(next)}))`, { transaction });
  }
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') };
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'suggestions',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
          user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
          title: { type: DataTypes.STRING(150), allowNull: false },
          description: { type: DataTypes.STRING(4000), allowNull: false },
          category: { type: DataTypes.STRING(20), allowNull: false },
          contact: { type: DataTypes.STRING(200), allowNull: true },
          status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new' },
          admin_reply: { type: DataTypes.STRING(4000), allowNull: true },
          replied_at: { type: DataTypes.DATE, allowNull: true },
          replied_by_user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
          created_at: now,
          updated_at: now,
        },
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_category_check', { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE suggestions ADD CONSTRAINT suggestions_category_check CHECK (category IN (${list(CATEGORIES)}))`, { transaction });
      await queryInterface.sequelize.query('ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_status_check', { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE suggestions ADD CONSTRAINT suggestions_status_check CHECK (status IN (${list(STATUSES)}))`, { transaction });
      await queryInterface.addIndex('suggestions', ['workspace_id', 'created_at'], { name: 'suggestions_workspace_created_idx', transaction });
      await queryInterface.addIndex('suggestions', ['status', 'created_at'], { name: 'suggestions_status_created_idx', transaction });

      await setNotificationTypes(queryInterface, (types) => (types.includes('suggestion') ? types : [...types, 'suggestion']), transaction);
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query("DELETE FROM platform_notification_prefs WHERE type = 'suggestion'", { transaction });
      await queryInterface.sequelize.query("DELETE FROM platform_notifications WHERE type = 'suggestion'", { transaction });
      await setNotificationTypes(queryInterface, (types) => types.filter((t) => t !== 'suggestion'), transaction);
      await queryInterface.dropTable('suggestions', { transaction });
    });
  },
};
