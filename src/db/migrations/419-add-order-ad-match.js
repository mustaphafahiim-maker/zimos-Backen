'use strict';

/**
 * orders.ad_match (SPEC §13.2): the ad platforms' browser ids the storefront
 * sent with the checkout — Meta's _fbp/_fbc, TikTok's _ttp and ttclid, the
 * Snapchat click id, the GA4 client id — and the store's own visitor id. The
 * server-side Purchase (marketing/pixelEvents.js) sends them so the platform
 * matches the order to the shopper who clicked the ad, which can happen days
 * after the order (purchase_event_timing on_confirmed / on_delivered), when
 * the browser is long gone. No personal data: ids the platforms' own scripts
 * set. Storefront orders only.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders', 'ad_match', { type: Sequelize.JSONB, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orders', 'ad_match');
  },
};
