'use strict';

/**
 * The starter template gallery's usage count (item 401). A website already
 * records the template version it was copied from
 * (websites.source_template_version_id, migration 011); a funnel now does
 * too, when it is created from a funnel or landing template
 * (POST /funnels { templateVersionId }). The count is taken live from both
 * columns (templates/templateUsage.js), so trashing, restoring or purging a
 * site or funnel moves it without a counter to keep in step.
 *
 * Existing funnels stay NULL: none was made from a template before this.
 * ON DELETE SET NULL as on websites — the admin delete refuses a template
 * still in use, so that only matters for a direct database delete.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('funnels', 'source_template_version_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'template_versions', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "funnels_source_template_version_id_idx"
         ON "funnels" ("source_template_version_id") WHERE "source_template_version_id" IS NOT NULL;`
    );
    // The gallery groups websites by this column on every listing.
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "websites_source_template_version_id_idx"
         ON "websites" ("source_template_version_id") WHERE "source_template_version_id" IS NOT NULL;`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "websites_source_template_version_id_idx";`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "funnels_source_template_version_id_idx";`);
    await queryInterface.removeColumn('funnels', 'source_template_version_id');
  },
};
