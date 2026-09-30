'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * Collections become a tree the merchant arranges by hand.
 *
 *  - collections.parent_id: the parent collection, null for a top-level one.
 *    ON DELETE SET NULL, so deleting a parent lifts its children to the top
 *    level instead of deleting them. The API (catalogService) refuses a cycle
 *    and anything deeper than three levels; the database only guarantees the
 *    parent exists.
 *  - collections.position: order among siblings (lowest first, then name).
 *  - collections.image_url: the collection's picture on the storefront.
 *  - product_collections.position: the order of products inside a collection.
 *
 * `rules` is left exactly as it is: stored, not applied.
 *
 * Existing rows are numbered in the order the dashboard already showed them —
 * collections by creation time within each store, products by when they were
 * added to the collection — so nothing a merchant sees moves.
 *
 * Both new indexes serve reads that filter by workspace or collection and
 * sort by position; product_collections grows with the catalogue, so they
 * are built CONCURRENTLY, after the columns (no transaction around this file).
 */
const COLLECTIONS_INDEX = 'collections_workspace_parent_position_idx';
const PRODUCT_COLLECTIONS_INDEX = 'product_collections_collection_position_idx';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const collections = await queryInterface.describeTable('collections');
    if (!collections.parent_id) {
      await queryInterface.addColumn('collections', 'parent_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'collections', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
    if (!collections.position) {
      await queryInterface.addColumn('collections', 'position', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
      await queryInterface.sequelize.query(`
        UPDATE collections c
           SET position = ranked.n
          FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, id) - 1 AS n
                  FROM collections) ranked
         WHERE ranked.id = c.id;`);
    }
    if (!collections.image_url) {
      await queryInterface.addColumn('collections', 'image_url', {
        type: Sequelize.STRING(1000),
        allowNull: true,
      });
    }

    const links = await queryInterface.describeTable('product_collections');
    if (!links.position) {
      await queryInterface.addColumn('product_collections', 'position', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
      await queryInterface.sequelize.query(`
        UPDATE product_collections pc
           SET position = ranked.n
          FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY created_at, id) - 1 AS n
                  FROM product_collections) ranked
         WHERE ranked.id = pc.id;`);
    }

    await createIndexConcurrently(queryInterface, {
      name: COLLECTIONS_INDEX,
      table: 'collections',
      definition: '(workspace_id, parent_id, position)',
    });
    await createIndexConcurrently(queryInterface, {
      name: PRODUCT_COLLECTIONS_INDEX,
      table: 'product_collections',
      definition: '(collection_id, position)',
    });
  },

  down: async (queryInterface) => {
    await dropIndexConcurrently(queryInterface, PRODUCT_COLLECTIONS_INDEX);
    await dropIndexConcurrently(queryInterface, COLLECTIONS_INDEX);
    await queryInterface.removeColumn('product_collections', 'position');
    await queryInterface.removeColumn('collections', 'image_url');
    await queryInterface.removeColumn('collections', 'position');
    await queryInterface.removeColumn('collections', 'parent_id');
  },
};
