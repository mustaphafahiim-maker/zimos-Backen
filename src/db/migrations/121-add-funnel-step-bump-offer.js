'use strict';

/**
 * The order bump a funnel's checkout step offers: funnel_steps.bump_offer_id,
 * the offer shown as "add to your order" on that step's form (the store's own
 * checkout reads its bump from workspaces.settings.order_bump instead — no
 * column needed there). Null, as every step is today, is "no bump".
 *
 * ON DELETE SET NULL: offers are archived rather than deleted, but a deleted
 * one must not take the step with it. funnel_steps is a small table (a few
 * rows per funnel), so no index and no CONCURRENTLY step.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const steps = await queryInterface.describeTable('funnel_steps');
    if (!steps.bump_offer_id) {
      await queryInterface.addColumn('funnel_steps', 'bump_offer_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'offers', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  },

  down: async (queryInterface) => {
    const steps = await queryInterface.describeTable('funnel_steps');
    if (steps.bump_offer_id) await queryInterface.removeColumn('funnel_steps', 'bump_offer_id');
  },
};
