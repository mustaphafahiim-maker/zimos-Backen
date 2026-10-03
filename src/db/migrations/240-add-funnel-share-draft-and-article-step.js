'use strict';

/**
 * Funnels (SPEC §9.1, §9.2):
 *   funnels.share_code        a code another merchant enters to get a copy
 *   funnels.draft_data        the map editor's auto-saved, not-yet-applied state
 *   funnels.draft_updated_at  when that draft was last written
 *   step type 'article'       an advertorial page before the product page
 *
 * Postgres cannot drop a value from an enum, so `down` leaves 'article' in
 * place (harmless: nothing can use it once the code that offers it is gone).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('funnels', 'share_code', { type: DataTypes.STRING(20), allowNull: true, unique: true });
    await queryInterface.addColumn('funnels', 'draft_data', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('funnels', 'draft_updated_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.sequelize.query(`ALTER TYPE "enum_funnel_steps_step_type" ADD VALUE IF NOT EXISTS 'article'`);
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('funnels', 'draft_updated_at');
    await queryInterface.removeColumn('funnels', 'draft_data');
    await queryInterface.removeColumn('funnels', 'share_code');
  },
};
