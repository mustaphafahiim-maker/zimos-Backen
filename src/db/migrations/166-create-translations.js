'use strict';

const { guarded } = require('../migrationGuards');

/**
 * translations: the merchant's own content in another language (SPEC §8.10).
 * One row per (entity, locale, field): a product's name in French, a
 * collection's description in English. The original stays on the entity
 * itself; a missing translation simply shows the original.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('translations', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
      },
      entity_type: { type: DataTypes.STRING(40), allowNull: false },
      entity_id: { type: DataTypes.UUID, allowNull: false },
      locale: { type: DataTypes.STRING(10), allowNull: false },
      field: { type: DataTypes.STRING(60), allowNull: false },
      value: { type: DataTypes.TEXT, allowNull: false },
      updated_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('translations', ['workspace_id', 'entity_type', 'entity_id', 'locale', 'field'], {
      unique: true,
      name: 'translations_entity_locale_field_uq',
    });
    await queryInterface.addIndex('translations', ['workspace_id', 'locale'], { name: 'translations_workspace_locale_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('translations');
  },
};
