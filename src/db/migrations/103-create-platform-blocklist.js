'use strict';

/**
 * The platform-wide blocklist: identifiers a platform admin has blocked from
 * ordering in every workspace (modules/risk/platformBlocklistService).
 *
 * One row per (type, value). `value` is the NORMALIZED identifier, the thing
 * order creation compares against:
 *
 *   phone    digits with country code, exactly as core/utils/phone
 *            normalizePhone produces it — the same form customers.phone_normalized holds
 *   email    trimmed and lowercased
 *   address  zimos_address_fingerprint(country, city, addressLine), below
 *
 * `label` is what the admin saw when blocking it (the phone as typed, the
 * address in words) — the fingerprint alone is unreadable.
 *
 * IP addresses are deliberately not a type: orders do not record the
 * shopper's IP, and the one the API sees at checkout can be the storefront
 * server's or a carrier NAT shared by thousands of shoppers.
 *
 * An expired row stays (the admin can see it lapsed, and extend it) but no
 * longer matches — expiry is checked at read time, never by a sweeper.
 */

/**
 * Folds one address part down to what identifies it: the search folding from
 * migration 088 (Arabic letter variants, tashkeel, case), Arabic-Indic digits
 * read as ASCII, and then everything that is not a digit, a Latin letter or
 * an Arabic letter (U+0621..U+064A) dropped — spaces, commas, the Arabic
 * comma, dashes, "#". "12 شارع التحرير، الدقي" and "12شارع  التحرير - الدقى"
 * fold to the same string.
 *
 * Written with U&'' escapes for the same reason migration 088 does: a
 * mangled byte would not fail, it would quietly stop folding one character.
 */
const FOLD_FUNCTION = `
  CREATE OR REPLACE FUNCTION zimos_address_fold(value text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $fn$
    SELECT regexp_replace(
      translate(
        zimos_normalize_search(value),
        U&'\\0660\\0661\\0662\\0663\\0664\\0665\\0666\\0667\\0668\\0669\\06F0\\06F1\\06F2\\06F3\\06F4\\06F5\\06F6\\06F7\\06F8\\06F9',
        '01234567890123456789'),
      '[^0-9a-z' || U&'\\0621' || '-' || U&'\\064A' || ']+',
      '',
      'g')
  $fn$;`;

/**
 * An address's fingerprint: md5 over country, city and street line, each
 * folded. Province, postal code and delivery notes are left out on purpose —
 * they are the parts buyers fill in least consistently, and including them
 * would let the same doorstep produce several fingerprints.
 *
 * NULL when the city or the street line folds to nothing: an empty address is
 * not an identifier, and must never match another empty address.
 *
 * The one definition, used by order creation and by the admin's risk signals
 * alike — JavaScript never computes a fingerprint itself, so the two cannot
 * drift apart.
 */
const FINGERPRINT_FUNCTION = `
  CREATE OR REPLACE FUNCTION zimos_address_fingerprint(country text, city text, address_line text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $fn$
    SELECT CASE
      WHEN zimos_address_fold(city) = '' OR zimos_address_fold(address_line) = '' THEN NULL
      ELSE md5(lower(btrim(coalesce(country, ''))) || '|' || zimos_address_fold(city) || '|' || zimos_address_fold(address_line))
    END
  $fn$;`;

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'platform_blocklist_entries',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          type: { type: DataTypes.STRING(20), allowNull: false },
          value: { type: DataTypes.STRING(255), allowNull: false },
          label: { type: DataTypes.STRING(600), allowNull: false },
          reason: { type: DataTypes.STRING(300), allowNull: false },
          expires_at: { type: DataTypes.DATE, allowNull: true },
          created_by_user_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE platform_blocklist_entries
           ADD CONSTRAINT platform_blocklist_entries_type_check CHECK (type IN ('phone', 'email', 'address'))`,
        { transaction }
      );
      // Also the lookup order creation makes: (type, value) equality.
      await queryInterface.addIndex('platform_blocklist_entries', ['type', 'value'], {
        unique: true,
        name: 'platform_blocklist_entries_type_value_unique',
        transaction,
      });
      await queryInterface.addIndex('platform_blocklist_entries', ['created_at'], {
        name: 'platform_blocklist_entries_created_at_idx',
        transaction,
      });

      // After zimos_normalize_search (migration 088), which the fold calls.
      await queryInterface.sequelize.query(FOLD_FUNCTION, { transaction });
      await queryInterface.sequelize.query(FINGERPRINT_FUNCTION, { transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('platform_blocklist_entries', { transaction });
      await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS zimos_address_fingerprint(text, text, text);', {
        transaction,
      });
      await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS zimos_address_fold(text);', { transaction });
    });
  },
};
