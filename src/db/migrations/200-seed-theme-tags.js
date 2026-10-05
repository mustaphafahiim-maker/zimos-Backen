'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Theme tags (SPEC §8.1 "each theme: … name, tags"): a starting set for the
 * themes the catalog seeded (migration 191), from a small shared vocabulary
 * the dashboard translates (ThemeGallery `tag_<key>`). The platform console
 * edits them afterwards (PATCH /admin/themes/:key). Only empty tag lists are
 * filled, so a console edit is never overwritten.
 */
const TAGS = {
  original: ['customizable', 'simple'],
  elegant: ['serif', 'luxury', 'spacious'],
  bold: ['bold', 'colorful', 'modern'],
  minimal: ['minimal', 'modern', 'flat'],
  classic: ['serif', 'trusted', 'shadows'],
  warm: ['rounded', 'cozy', 'soft'],
  glass: ['glass', 'modern', 'colorful'],
  uokids: ['playful', 'rounded', 'kids'],
};

module.exports = {
  up: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    for (const [key, tags] of Object.entries(TAGS)) {
      await queryInterface.sequelize.query(`UPDATE themes SET tags = ARRAY[:tags]::varchar(40)[] WHERE key = :key AND cardinality(tags) = 0`, {
        replacements: { key, tags },
      });
    }
  },
  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    for (const [key, tags] of Object.entries(TAGS)) {
      await queryInterface.sequelize.query(`UPDATE themes SET tags = '{}' WHERE key = :key AND tags = ARRAY[:tags]::varchar(40)[]`, { replacements: { key, tags } });
    }
  },
};
