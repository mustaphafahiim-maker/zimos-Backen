'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Menu options (catalog/menuOptions.js): a product's option groups ("Size",
 * "Extras") and their choices, each adding its price to the unit price.
 *
 *  - product_option_groups       name, required, min/max picks, active, order
 *  - product_option_choices      name, price delta (minor units, >= 0), active, order
 *  - cart_items.selected_options     the picks on a cart line, [{ groupId, choiceIds }]
 *  - order_items.options_snapshot    what the order line was sold with: group and
 *                                    choice names and each choice's price
 *
 * The two new line columns are nullable without a default (a catalogue change
 * on large tables); a line without options is exactly as before.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') };
    await queryInterface.createTable('product_option_groups', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      min_select: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      max_select: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('product_option_groups', ['workspace_id', 'product_id', 'sort_order'], { name: 'product_option_groups_product_idx' });
    await queryInterface.sequelize.query('ALTER TABLE product_option_groups DROP CONSTRAINT IF EXISTS product_option_groups_select_check');
    await queryInterface.sequelize.query(
      'ALTER TABLE product_option_groups ADD CONSTRAINT product_option_groups_select_check CHECK (min_select >= 0 AND max_select >= 1 AND min_select <= max_select)'
    );

    await queryInterface.createTable('product_option_choices', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      group_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'product_option_groups', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      price_delta_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('product_option_choices', ['group_id', 'sort_order'], { name: 'product_option_choices_group_idx' });
    await queryInterface.sequelize.query('ALTER TABLE product_option_choices DROP CONSTRAINT IF EXISTS product_option_choices_price_check');
    await queryInterface.sequelize.query('ALTER TABLE product_option_choices ADD CONSTRAINT product_option_choices_price_check CHECK (price_delta_amount >= 0)');

    await queryInterface.addColumn('cart_items', 'selected_options', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('order_items', 'options_snapshot', { type: DataTypes.JSONB, allowNull: true });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('order_items', 'options_snapshot');
    await queryInterface.removeColumn('cart_items', 'selected_options');
    await queryInterface.dropTable('product_option_choices');
    await queryInterface.dropTable('product_option_groups');
  },
};
