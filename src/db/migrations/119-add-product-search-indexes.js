'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * Indexes for the storefront's product search and tag filter.
 *
 *  - products_name_normalized_trgm_idx: a trigram GIN over the product name as
 *    zimos_normalize_search (migration 088) folds it — the same Arabic folding
 *    the orders search uses (alef forms, taa marbuta, alef maqsura, tashkeel,
 *    tatweel) plus lower(). It serves `LIKE '%term%'` and prefix matches on
 *    the name for search and the suggestions box. The expression is
 *    byte-for-byte what storefront/productSearch.js builds; an index on an
 *    expression that merely means the same is never used.
 *  - products_tags_gin_idx: the `tags && ARRAY[...]` filter.
 *
 * Neither leads with workspace_id — a GIN cannot without btree_gin — and they
 * do not need to: the workspace filter stays in every query and the bitmap is
 * rechecked against it (the reasoning in 088 applies unchanged).
 *
 * products is the biggest catalogue table, so both are built CONCURRENTLY
 * (see ../concurrentIndex.js); this file runs with no transaction around it.
 */
const INDEXES = [
  {
    name: 'products_name_normalized_trgm_idx',
    table: 'products',
    definition: 'USING gin (zimos_normalize_search(name) gin_trgm_ops)',
  },
  {
    name: 'products_tags_gin_idx',
    table: 'products',
    definition: 'USING gin (tags)',
  },
];

module.exports = {
  up: async (queryInterface) => {
    // 088 created both; asked again so this file stands on its own.
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    for (const index of INDEXES) await createIndexConcurrently(queryInterface, index);
  },

  down: async (queryInterface) => {
    for (const index of INDEXES) await dropIndexConcurrently(queryInterface, index.name);
  },
};
