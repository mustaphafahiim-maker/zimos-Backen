'use strict';

/**
 * The Uokids store template (data/uokids-store-template.js): one store's own
 * home page, rebuilt from the showcase sections, offered in the template
 * gallery. A data migration like 123, because a release runs db:migrate only.
 *
 * Safe to run on any database: it adds the template and its first version
 * only where they are missing, and touches no existing site.
 */

const { template, version } = require('./data/uokids-store-template');

module.exports = {
  up: async (queryInterface) => {
    const { QueryTypes } = queryInterface.sequelize;
    const now = new Date();

    const [hasTemplate] = await queryInterface.sequelize.query('SELECT id FROM templates WHERE id = $id', {
      bind: { id: template.id },
      type: QueryTypes.SELECT,
    });
    if (!hasTemplate) {
      await queryInterface.sequelize.query(
        `INSERT INTO templates (id, name, category, thumbnail_url, is_published, kind, price_amount, is_free, primary_color, tags, rtl, created_at, updated_at)
         VALUES ($id, $name, $category, $thumbnailUrl, true, $kind, 0, true, $primaryColor, $tags::varchar[], true, $now, $now)`,
        {
          bind: {
            id: template.id,
            name: template.name,
            category: template.category,
            thumbnailUrl: template.thumbnailUrl,
            kind: template.kind,
            primaryColor: template.primaryColor,
            tags: template.tags,
            now,
          },
        }
      );
    }

    const [hasVersion] = await queryInterface.sequelize.query('SELECT id FROM template_versions WHERE id = $id', {
      bind: { id: version.id },
      type: QueryTypes.SELECT,
    });
    if (!hasVersion) {
      await queryInterface.bulkInsert('template_versions', [
        {
          id: version.id,
          template_id: template.id,
          version: 1,
          global_styles: JSON.stringify(version.globalStyles),
          pages: JSON.stringify(version.pages),
          sections: JSON.stringify([]),
          is_active: true,
          created_at: now,
          updated_at: now,
        },
      ]);
    }
  },

  down: async (queryInterface) => {
    await queryInterface.bulkDelete('template_versions', { id: version.id });
    await queryInterface.bulkDelete('templates', { id: template.id });
  },
};
