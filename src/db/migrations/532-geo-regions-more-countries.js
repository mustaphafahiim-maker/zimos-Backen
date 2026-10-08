'use strict';

const { rows } = require('../seed-data/geoRegionsMore');

/**
 * The platform's place list (geo_regions, migration 403) for the other
 * countries a store sells in: Morocco, Algeria, the Emirates, Kuwait, Jordan,
 * Libya, Palestine, Tunisia, Iraq, Qatar, Bahrain and Oman — their first-level
 * divisions and main cities (db/seed-data/geoRegionsMore.js).
 *
 * Inserts only the codes not there yet (ON CONFLICT DO NOTHING), so it never
 * changes a row already in the table, and runs again harmlessly. A store's
 * own places (store_places) are another table and are not touched.
 *
 * Down removes the codes of that list — 403 never carried them, so they are
 * the rows this migration added — cities before their divisions.
 */
module.exports = {
  up: async (queryInterface) => {
    const list = rows();
    const now = new Date();
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200);
        const values = [];
        const bind = [];
        chunk.forEach((r) => {
          const at = bind.length;
          bind.push(r.code, r.country, r.level, r.parentCode, r.nameAr, r.nameEn, r.sortOrder, now);
          values.push(`($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7}, $${at + 8}, $${at + 8})`);
        });
        await queryInterface.sequelize.query(
          `INSERT INTO geo_regions (code, country, level, parent_code, name_ar, name_en, sort_order, created_at, updated_at)
           VALUES ${values.join(', ')}
           ON CONFLICT (code) DO NOTHING`,
          { bind, transaction }
        );
      }
    });
  },

  down: async (queryInterface) => {
    const list = rows();
    const cities = list.filter((r) => r.level === 'city').map((r) => r.code);
    const divisions = list.filter((r) => r.level !== 'city').map((r) => r.code);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DELETE FROM geo_regions WHERE code = ANY($1::text[])', { bind: [cities], transaction });
      await queryInterface.sequelize.query('DELETE FROM geo_regions WHERE code = ANY($1::text[])', { bind: [divisions], transaction });
    });
  },
};
