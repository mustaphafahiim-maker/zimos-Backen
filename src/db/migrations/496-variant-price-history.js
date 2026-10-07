'use strict';

/** Every variant price change (modules/priceHistory, spec-gaps item 234). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('variant_price_history', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      price_amount: { type: Sequelize.BIGINT, allowNull: false },
      compare_at_amount: { type: Sequelize.BIGINT, allowNull: true },
      changed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('variant_price_history', ['variant_id', 'changed_at'], { name: 'variant_price_history_idx' });
    // Today's prices as the starting point.
    await queryInterface.sequelize.query(
      'INSERT INTO variant_price_history (workspace_id, variant_id, price_amount, compare_at_amount, changed_at) SELECT workspace_id, id, price_amount, compare_at_amount, COALESCE(updated_at, now()) FROM product_variants'
    );
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('variant_price_history');
  },
};
