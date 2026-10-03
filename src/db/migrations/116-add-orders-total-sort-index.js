'use strict';

/**
 * The index behind sorting the orders list by total (high to low and low to
 * high), the same shape 087 gives the newest-first list: workspace, then the
 * sort key, then `id` as the tie-breaker the keyset cursor pages on. One
 * index serves both directions — a btree reads backwards when every column
 * flips together. Oldest-first needs nothing new: it is 087's index read
 * backwards.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addIndex(
      'orders',
      [{ name: 'workspace_id' }, { name: 'total_amount', order: 'DESC' }, { name: 'id', order: 'DESC' }],
      { name: 'orders_workspace_total_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('orders', 'orders_workspace_total_idx');
  },
};
