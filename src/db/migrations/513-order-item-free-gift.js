'use strict';

/**
 * order_items.is_free_gift — the line is a free gift the server added
 * (freeGifts/, item 276), so editing the order later (orders/orderItemsEdit.js,
 * item 344) still leaves its units out of a bundle tier. A cart-offer line
 * pinned at 0 looks the same by price and label, and does count.
 * Null on lines written before this migration.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('order_items', 'is_free_gift', { type: Sequelize.BOOLEAN, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('order_items', 'is_free_gift');
  },
};
