'use strict';

/**
 * Offer rules of SPEC §10.2–10.4 (lane 3):
 *   order_bumps        up to three "add to your order" tick boxes per product
 *                      (product_id null = on every product);
 *   cross_sell_rules   "customers also bought": trigger products/collections
 *                      → products to suggest, per placement;
 *   upsell_rules       the one-tap offer on the store's thank-you page;
 *   upsell_acceptances one accepted upsell per order, so a double tap or a
 *                      retried request never adds the line twice.
 * A bump and an upsell sell an existing offer, so the server prices them the
 * way it prices any offer line.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const id = { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4, allowNull: false };
    const workspace = {
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
    };
    const stamps = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    };
    const offer = { type: Sequelize.UUID, allowNull: false, references: { model: 'offers', key: 'id' }, onDelete: 'CASCADE' };
    const product = { type: Sequelize.UUID, allowNull: true, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' };

    await queryInterface.createTable('order_bumps', {
      id,
      workspace_id: workspace,
      product_id: product,
      offer_id: offer,
      headline: { type: Sequelize.STRING(120), allowNull: true },
      description: { type: Sequelize.STRING(300), allowNull: true },
      pre_checked: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ...stamps,
    });
    await queryInterface.addIndex('order_bumps', ['workspace_id', 'product_id'], { name: 'order_bumps_workspace_product' });

    await queryInterface.createTable('cross_sell_rules', {
      id,
      workspace_id: workspace,
      name: { type: Sequelize.STRING(120), allowNull: false },
      trigger_product_ids: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      trigger_collection_ids: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      offer_product_ids: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      placement: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'cart' },
      max_items: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 4 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ...stamps,
    });
    await queryInterface.addIndex('cross_sell_rules', ['workspace_id', 'placement'], { name: 'cross_sell_rules_workspace_placement' });

    await queryInterface.createTable('upsell_rules', {
      id,
      workspace_id: workspace,
      trigger_product_id: product,
      offer_id: offer,
      headline: { type: Sequelize.STRING(120), allowNull: true },
      description: { type: Sequelize.STRING(300), allowNull: true },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ...stamps,
    });
    await queryInterface.addIndex('upsell_rules', ['workspace_id', 'trigger_product_id'], { name: 'upsell_rules_workspace_product' });

    await queryInterface.createTable('upsell_acceptances', {
      id,
      workspace_id: workspace,
      order_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      upsell_rule_id: { type: Sequelize.UUID, allowNull: true },
      offer_id: { type: Sequelize.UUID, allowNull: false },
      order_item_id: { type: Sequelize.UUID, allowNull: true },
      amount: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      ...stamps,
    });
    await queryInterface.addIndex('upsell_acceptances', ['order_id'], { unique: true, name: 'upsell_acceptances_order_unique' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('upsell_acceptances');
    await queryInterface.dropTable('upsell_rules');
    await queryInterface.dropTable('cross_sell_rules');
    await queryInterface.dropTable('order_bumps');
  },
};
