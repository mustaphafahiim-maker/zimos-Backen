'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The theme catalog (SPEC §8.1): which store themes exist, as data the
 * platform console edits, rather than a list fixed in the dashboard.
 *
 *  - themes: one row per theme the storefront can draw (a theme is code in
 *    apps/storefront — brandTheme.ts and its stylesheet — so a row only
 *    describes it: names, category, kind, tags, preview pictures, order,
 *    whether stores may pick it, and an optional price). `price_amount` stays
 *    NULL (free) unless the console sets one; paid themes can't be bought yet,
 *    the wallet being an open decision (SPEC §21).
 *  - workspace_themes: the themes a store has used or owns, with how it got
 *    each (free | purchase).
 *
 * Seeded with the themes the storefront already draws, all free, so nothing
 * a store sees changes.
 */

const SEED = [
  ['original', 'Original', 'الأصلي', 'The store as it was before themes: your template\'s own look.', 'شكل المتجر قبل الثيمات: شكل القالب نفسه.', 'general'],
  ['elegant', 'Elegant', 'أنيق', 'Serif headings, soft corners and quiet cards.', 'عناوين بخط مزخرف، حواف ناعمة وبطاقات هادئة.', 'fashion'],
  ['bold', 'Bold', 'جريء', 'Heavy type and strong blocks of colour.', 'خطوط عريضة ومساحات لون قوية.', 'electronics'],
  ['minimal', 'Minimal', 'بسيط', 'Plenty of white space and thin lines.', 'مساحات بيضاء كتير وخطوط رفيعة.', 'general'],
  ['classic', 'Classic', 'كلاسيكي', 'A familiar shop layout with framed cards.', 'شكل متجر مألوف وبطاقات بإطار.', 'furniture'],
  ['warm', 'Warm', 'دافئ', 'Rounded shapes and warm paper tones.', 'أشكال مدوّرة وألوان ورق دافية.', 'beauty'],
  ['glass', 'Glass', 'زجاجي', 'Frosted cards over a soft gradient.', 'بطاقات زجاجية فوق تدرّج ناعم.', 'electronics'],
  ['uokids', 'Uokids', 'يوكيدز', 'Playful colours and big rounded buttons.', 'ألوان مرحة وأزرار كبيرة مدوّرة.', 'kids'],
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      const created = await queryInterface.createTable(
        'themes',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()'), allowNull: false },
          key: { type: DataTypes.STRING(40), allowNull: false, unique: true },
          name: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          description: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          // store | landing
          kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'store' },
          category: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'general' },
          tags: { type: DataTypes.ARRAY(DataTypes.STRING(40)), allowNull: false, defaultValue: [] },
          preview_images: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
          price_amount: { type: DataTypes.BIGINT, allowNull: true },
          price_currency: { type: DataTypes.STRING(3), allowNull: true },
          position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        },
        { transaction }
      );
      await queryInterface.createTable(
        'workspace_themes',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()'), allowNull: false },
          workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
          theme_key: { type: DataTypes.STRING(40), allowNull: false },
          // free | purchase
          source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'free' },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        },
        { transaction }
      );
      await queryInterface.addIndex('workspace_themes', ['workspace_id', 'theme_key'], {
        unique: true,
        name: 'workspace_themes_workspace_theme_uq',
        transaction,
      });
      // The catalogue's first rows, only when this run made the table.
      if (created) await queryInterface.bulkInsert(
        'themes',
        SEED.map(([key, en, ar, descEn, descAr, category], i) => ({
          key,
          name: JSON.stringify({ en, ar }),
          description: JSON.stringify({ en: descEn, ar: descAr }),
          kind: 'store',
          category,
          position: i,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        })),
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('workspace_themes', { transaction });
      await queryInterface.dropTable('themes', { transaction });
    });
  },
};
