'use strict';

const { guarded } = require('../migrationGuards');

const { rows } = require('../seed-data/geoRegions');

/**
 * The platform's place list (SPEC §12.1): governorates / regions and their
 * cities, for Egypt (with North Coast) and Saudi Arabia. No workspace: every
 * store reads the same list. Seeded here from db/seed-data/geoRegions.js;
 * codes are permanent (carrier_region_map and stores keep them).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const created = await queryInterface.createTable('geo_regions', {
      code: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
      country: { type: DataTypes.STRING(2), allowNull: false },
      // governorate (a governorate, North Coast, a Saudi region) | city
      level: { type: DataTypes.STRING(20), allowNull: false },
      parent_code: { type: DataTypes.STRING(80), allowNull: true, references: { model: 'geo_regions', key: 'code' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      name_ar: { type: DataTypes.STRING(120), allowNull: false },
      name_en: { type: DataTypes.STRING(120), allowNull: false },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('geo_regions', ['country', 'level'], { name: 'geo_regions_country_level_idx' });
    await queryInterface.addIndex('geo_regions', ['parent_code'], { name: 'geo_regions_parent_idx' });

    const now = new Date();
    if (created) await queryInterface.bulkInsert(
      'geo_regions',
      rows().map((r) => ({
        code: r.code,
        country: r.country,
        level: r.level,
        parent_code: r.parentCode,
        name_ar: r.nameAr,
        name_en: r.nameEn,
        sort_order: r.sortOrder,
        created_at: now,
        updated_at: now,
      }))
    );
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('geo_regions');
  },
};
