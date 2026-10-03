'use strict';

/**
 * Split tests, geo redirects and funnel settings (SPEC §9.6, §9.7).
 *
 * experiments (the table existed with no routes): which funnel step a test
 * runs on, how its winner is chosen, and the winner once there is one.
 *   funnel_id, step_key   the step the test replaces the page of
 *   auto_winner           { enabled, afterVisits, metric }
 *   winner_variant_key    set when a winner was picked (by hand or automatically)
 *
 * geo_redirects: "visitors from these countries who open funnel X get funnel
 * Y instead".
 *
 * funnels.settings: the funnel's own currency, icon and search title.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('experiments', 'funnel_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'funnels', key: 'id' },
      onDelete: 'CASCADE',
    });
    await queryInterface.addColumn('experiments', 'step_key', { type: DataTypes.STRING(100), allowNull: true });
    await queryInterface.addColumn('experiments', 'auto_winner', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('experiments', 'winner_variant_key', { type: DataTypes.STRING(50), allowNull: true });
    await queryInterface.addIndex('experiments', ['workspace_id', 'funnel_id', 'step_key'], {
      name: 'experiments_funnel_step_idx',
    });

    await queryInterface.createTable('geo_redirects', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
      },
      source_funnel_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'CASCADE',
      },
      target_funnel_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'CASCADE',
      },
      countries: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('geo_redirects', ['workspace_id', 'source_funnel_id'], {
      name: 'geo_redirects_source_idx',
    });

    await queryInterface.addColumn('funnels', 'settings', { type: DataTypes.JSONB, allowNull: false, defaultValue: {} });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('funnels', 'settings');
    await queryInterface.dropTable('geo_redirects');
    await queryInterface.removeIndex('experiments', 'experiments_funnel_step_idx');
    await queryInterface.removeColumn('experiments', 'winner_variant_key');
    await queryInterface.removeColumn('experiments', 'auto_winner');
    await queryInterface.removeColumn('experiments', 'step_key');
    await queryInterface.removeColumn('experiments', 'funnel_id');
  },
};
