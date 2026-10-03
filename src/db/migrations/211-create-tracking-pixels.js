'use strict';

const crypto = require('crypto');
const secretBox = require('../../core/utils/secretBox');

/**
 * tracking_pixels (SPEC §13.1): a store can have several pixels per platform,
 * each with its own label, Conversions-API token, test event code and scope
 * (the whole store, some funnels, or some products).
 *
 * Until now a store had one ID per platform in
 * workspaces.settings.tracking_pixels and one token per platform in its
 * "server_pixels" integration. The `up` copies both into rows here — one
 * store-wide pixel per platform that had an ID, with CAPI switched on where
 * a token existed. The old settings key and integration row are left as they
 * are (nothing reads them afterwards), so `down` only drops the table.
 */

// platform → [settings.tracking_pixels key, server_pixels secret key]
const LEGACY = [
  ['meta', 'meta', 'metaAccessToken'],
  ['tiktok', 'tiktok', 'tiktokAccessToken'],
  ['snapchat', 'snapchat', 'snapchatAccessToken'],
  ['google', 'google_tag', 'googleApiSecret'],
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('tracking_pixels', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      platform: { type: DataTypes.STRING(20), allowNull: false },
      pixel_id: { type: DataTypes.STRING(64), allowNull: false },
      label: { type: DataTypes.STRING(120), allowNull: true },
      capi_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      capi_token_sealed: { type: DataTypes.TEXT, allowNull: true },
      test_event_code: { type: DataTypes.STRING(100), allowNull: true },
      scope_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'all' },
      scope_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      last_sent_at: { type: DataTypes.DATE, allowNull: true },
      last_error: { type: DataTypes.STRING(500), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('tracking_pixels', ['workspace_id', 'platform', 'pixel_id'], {
      name: 'tracking_pixels_workspace_platform_pixel_idx',
      unique: true,
    });

    const [workspaces] = await queryInterface.sequelize.query(
      `SELECT w.id, w.settings->'tracking_pixels' AS pixels, i.secrets_sealed
         FROM workspaces w
         LEFT JOIN workspace_integrations i ON i.workspace_id = w.id AND i.provider = 'server_pixels'
        WHERE jsonb_typeof(w.settings->'tracking_pixels') = 'object'`
    );
    const rows = [];
    for (const w of workspaces) {
      let secrets = {};
      try {
        secrets = w.secrets_sealed ? JSON.parse(secretBox.open(w.secrets_sealed) || '{}') : {};
      } catch {
        // Sealed with a key this environment no longer has: the IDs still
        // move over, the merchant re-enters the token.
        secrets = {};
      }
      for (const [platform, settingsKey, secretKey] of LEGACY) {
        const pixelId = w.pixels && typeof w.pixels[settingsKey] === 'string' ? w.pixels[settingsKey].trim() : '';
        if (!pixelId) continue;
        const token = secrets[secretKey];
        rows.push({
          id: crypto.randomUUID(),
          workspace_id: w.id,
          platform,
          pixel_id: pixelId,
          capi_enabled: Boolean(token),
          capi_token_sealed: token ? secretBox.seal(token) : null,
          test_event_code: platform === 'meta' && secrets.metaTestEventCode ? String(secrets.metaTestEventCode).slice(0, 100) : null,
          scope_type: 'all',
          scope_ids: '[]',
          config: '{}',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }
    if (rows.length) await queryInterface.bulkInsert('tracking_pixels', rows);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('tracking_pixels');
  },
};
