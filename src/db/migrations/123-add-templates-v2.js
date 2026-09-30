'use strict';

/**
 * Version 2 of the five ready-made website templates, as data: the release
 * runs db:migrate only (never the seeders), and the gallery offers each
 * template's highest active version (templateService.latestActiveVersion), so
 * a new version row is all it takes.
 *
 * Each v2 is built from the editor's own section presets (store kit, hero with
 * picture, slideshow hero, living hero, trust badges, product floor,
 * collection tiles, FAQ, call-to-action band, …) with section settings for
 * background, width and spacing, a structure of its own per template, and the
 * pages that kind of store needs (about, shipping, size guide, warranty,
 * delivery). The content lives in data/templates-v2.json, generated from
 * apps/merchant-dashboard's blocks.ts presets.
 *
 * Styles: `globalStyles` carries `primaryColor` only — a different accent per
 * template, no longer five blues. The storefront never reads a site's
 * global_styles; fonts and light/dark belong to the store's look, which the
 * merchant picks. A template's colour reaches a store only when the merchant
 * has no look of their own (the dashboard's applyTemplateColour).
 *
 * Existing sites are untouched: a site is a copy of the version it was made
 * from, and the v1 rows stay as they are (still active, just no longer the
 * newest). A template this database does not have (the seeder never ran) is
 * skipped, and so is one that already has this version — the seeder calls
 * this same `up` for new databases. The gallery swatch
 * (templates.primary_color) moves to the new colour only where it still holds
 * the v1 colour, so an accent a platform admin set is kept.
 */

const TEMPLATE_IDS = {
  minimal: 'a0000000-0000-4000-8000-000000000001',
  fashion: 'a0000000-0000-4000-8000-000000000002',
  electronics: 'a0000000-0000-4000-8000-000000000003',
  food: 'a0000000-0000-4000-8000-000000000004',
  funnel: 'a0000000-0000-4000-8000-000000000005',
};
const V2_IDS = {
  minimal: 'c0000000-0000-4000-8000-000000000001',
  fashion: 'c0000000-0000-4000-8000-000000000002',
  electronics: 'c0000000-0000-4000-8000-000000000003',
  food: 'c0000000-0000-4000-8000-000000000004',
  funnel: 'c0000000-0000-4000-8000-000000000005',
};
// The v1 accents (seeder 20260103000000-website-templates.js).
const V1_COLORS = {
  minimal: '#2563EB',
  fashion: '#1D4ED8',
  electronics: '#1E40AF',
  food: '#0EA5E9',
  funnel: '#3B82F6',
};

function loadTemplates() {
  return require('./data/templates-v2.json');
}

module.exports = {
  TEMPLATE_IDS,
  V2_IDS,
  V1_COLORS,
  loadTemplates,

  up: async (queryInterface) => {
    const { QueryTypes } = queryInterface.sequelize;
    const templates = loadTemplates();
    for (const [key, template] of Object.entries(templates)) {
      const templateId = TEMPLATE_IDS[key];
      const versionId = V2_IDS[key];
      const [exists] = await queryInterface.sequelize.query('SELECT id FROM templates WHERE id = $templateId', {
        bind: { templateId },
        type: QueryTypes.SELECT,
      });
      if (!exists) continue;
      const [already] = await queryInterface.sequelize.query('SELECT id FROM template_versions WHERE id = $versionId', {
        bind: { versionId },
        type: QueryTypes.SELECT,
      });
      if (already) continue;

      // After whatever versions exist — an admin may have added some.
      const [{ max }] = await queryInterface.sequelize.query(
        'SELECT COALESCE(MAX(version), 0)::int AS max FROM template_versions WHERE template_id = $templateId',
        { bind: { templateId }, type: QueryTypes.SELECT }
      );
      await queryInterface.sequelize.query(
        `INSERT INTO template_versions (id, template_id, version, global_styles, pages, sections, is_active, created_at, updated_at)
         VALUES ($versionId, $templateId, $version, $globalStyles::jsonb, $pages::jsonb, '[]'::jsonb, true, NOW(), NOW())`,
        {
          bind: {
            versionId,
            templateId,
            version: max + 1,
            globalStyles: JSON.stringify({ primaryColor: template.primaryColor }),
            pages: JSON.stringify(template.pages),
          },
        }
      );
      await queryInterface.sequelize.query(
        `UPDATE templates SET primary_color = $color, updated_at = NOW()
          WHERE id = $templateId AND (primary_color IS NULL OR upper(primary_color) = upper($v1))`,
        { bind: { templateId, color: template.primaryColor, v1: V1_COLORS[key] } }
      );
    }
  },

  down: async (queryInterface) => {
    const templates = loadTemplates();
    for (const [key, template] of Object.entries(templates)) {
      // Sites made from v2 keep their pages; their source link goes (ON DELETE SET NULL).
      await queryInterface.sequelize.query('DELETE FROM template_versions WHERE id = $versionId', {
        bind: { versionId: V2_IDS[key] },
      });
      await queryInterface.sequelize.query(
        `UPDATE templates SET primary_color = $v1, updated_at = NOW()
          WHERE id = $templateId AND upper(primary_color) = upper($color)`,
        { bind: { templateId: TEMPLATE_IDS[key], color: template.primaryColor, v1: V1_COLORS[key] } }
      );
    }
  },
};
