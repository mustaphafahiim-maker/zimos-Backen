'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Saved views (SPEC §4.3: "Filters are saved as Saved views"): a teammate's
 * named filters for a list, kept on the server so they follow the person to
 * every browser. Per person and per store; `scope` names the list ('orders').
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('saved_views', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      scope: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      // The list's URL query string, without "?".
      query: { type: DataTypes.TEXT, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('saved_views', ['workspace_id', 'user_id', 'scope', 'name'], { unique: true, name: 'saved_views_owner_name_uniq' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('saved_views');
  },
};
