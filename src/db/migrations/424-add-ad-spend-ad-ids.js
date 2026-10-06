'use strict';

/**
 * ad_spend_daily.ad_ids (SPEC §15.4: orders matched to spend by "ad_id from
 * the URL parameters"): the ads behind a day's campaign spend, from an
 * ads-manager export at ad level (profit/adIdMatching.js). A JSON array of
 * lower-cased ids; null when the spend was entered per campaign.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ad_spend_daily', 'ad_ids', { type: Sequelize.JSONB, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ad_spend_daily', 'ad_ids');
  },
};
