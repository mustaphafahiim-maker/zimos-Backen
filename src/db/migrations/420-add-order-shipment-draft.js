'use strict';

/**
 * orders.shipment_draft (SPEC §4.4, the shipping card's "Save as draft"): the
 * courier, the courier's address codes, the weight tier and the note — or a
 * manual shipment's courier name, waybill and tracking link — kept on the
 * order without booking anything (orders/shipmentDraft.js). The order page
 * opens its shipment form with it; creating the shipment clears it.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders', 'shipment_draft', { type: Sequelize.JSONB, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orders', 'shipment_draft');
  },
};
