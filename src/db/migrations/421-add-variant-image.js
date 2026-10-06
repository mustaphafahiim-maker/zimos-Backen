'use strict';

/**
 * product_variants.image_url (SPEC §7.2): a variant's own picture — the red
 * shirt shows red. The store's product page shows it when the variant is
 * chosen, the cart and the product feed use it for that variant. Null: the
 * product's pictures, as before.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('product_variants', 'image_url', { type: Sequelize.STRING(1000), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('product_variants', 'image_url');
  },
};
