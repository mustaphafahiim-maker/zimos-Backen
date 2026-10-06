'use strict';

/**
 * A/B tests on a product page (SPEC §9.6 "A/B for products"): the split-test
 * engine's Experiment rows get a third subject, `product_page`, whose
 * subject_id is the product. Variants carry the prices and pictures to try
 * (modules/catalog/productTests.js).
 *
 * carts.visitor_id: the shopper who last added to the cart, so the cart and the
 * order made from it are priced at the price that shopper was shown.
 *
 * Down drops the column, removes the product tests and their assignments,
 * then rebuilds the enum without the value (Postgres cannot drop one value
 * from an enum).
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('carts', 'visitor_id', { type: Sequelize.STRING(64), allowNull: true });
    await queryInterface.sequelize.query(
      "ALTER TYPE enum_experiments_subject_type ADD VALUE IF NOT EXISTS 'product_page'"
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('carts', 'visitor_id');
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(
        "DELETE FROM experiment_assignments WHERE experiment_id IN (SELECT id FROM experiments WHERE subject_type::text = 'product_page')"
      );
      await q("DELETE FROM experiments WHERE subject_type::text = 'product_page'");
      await q('ALTER TYPE enum_experiments_subject_type RENAME TO enum_experiments_subject_type_old');
      await q("CREATE TYPE enum_experiments_subject_type AS ENUM ('website_page', 'funnel_step')");
      await q(
        'ALTER TABLE experiments ALTER COLUMN subject_type TYPE enum_experiments_subject_type USING subject_type::text::enum_experiments_subject_type'
      );
      await q('DROP TYPE enum_experiments_subject_type_old');
    });
  },
};
