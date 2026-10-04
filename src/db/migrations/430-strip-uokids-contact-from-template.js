'use strict';

/**
 * The Uokids store template (migration 335) carried that store's own contact
 * details in its theme settings — its WhatsApp number in the floating button,
 * its address, email and phone in the footer, and its social accounts — and
 * applying the template copied them into the new store, where no screen could
 * change them: shoppers' chats went to Uokids. (SPEC §8.2, queue item 101.)
 *
 * The storefront now takes these from the store's own settings (store info,
 * social links, floating WhatsApp). This removes them from the template, and
 * from every store that still holds Uokids' exact values — except a store that
 * is Uokids itself, where they are moved into its own settings when those are
 * empty, so it keeps showing them.
 */

const { VERSION_ID } = require('./data/uokids-store-template');

const WHATSAPP = '201007591211';
const EMAIL = 'info@uokids.com';
const isUokidsUrl = (url) => typeof url === 'string' && /uokids/i.test(url);

function strip(themeSettings) {
  const ts = themeSettings && typeof themeSettings === 'object' ? JSON.parse(JSON.stringify(themeSettings)) : {};
  const taken = {};
  if (ts.floating && ts.floating.whatsapp === WHATSAPP) {
    taken.whatsapp = ts.floating.whatsapp;
    delete ts.floating.whatsapp;
  }
  if (ts.footer && ts.footer.contact && ts.footer.contact.email === EMAIL) {
    taken.contact = ts.footer.contact;
    delete ts.footer.contact;
  }
  if (ts.footer && Array.isArray(ts.footer.social) && ts.footer.social.some((s) => s && isUokidsUrl(s.url))) {
    taken.social = ts.footer.social;
    delete ts.footer.social;
  }
  return { ts, taken };
}

module.exports = {
  up: async (queryInterface) => {
    const { QueryTypes } = queryInterface.sequelize;

    const [version] = await queryInterface.sequelize.query('SELECT global_styles FROM template_versions WHERE id = $id', {
      bind: { id: VERSION_ID },
      type: QueryTypes.SELECT,
    });
    if (version && version.global_styles && version.global_styles.themeSettings) {
      const { ts } = strip(version.global_styles.themeSettings);
      await queryInterface.sequelize.query('UPDATE template_versions SET global_styles = $styles::jsonb, updated_at = NOW() WHERE id = $id', {
        bind: { id: VERSION_ID, styles: JSON.stringify({ ...version.global_styles, themeSettings: ts }) },
      });
    }

    const stores = await queryInterface.sequelize.query(
      `SELECT id, slug, name, theme_settings, settings FROM workspaces
        WHERE theme_settings->'floating'->>'whatsapp' = $whatsapp
           OR theme_settings->'footer'->'contact'->>'email' = $email
           OR theme_settings->'footer'->>'social' ILIKE '%uokids%'`,
      { bind: { whatsapp: WHATSAPP, email: EMAIL }, type: QueryTypes.SELECT }
    );
    for (const store of stores) {
      const { ts, taken } = strip(store.theme_settings);
      const settings = { ...(store.settings || {}) };
      if (/uokids/i.test(`${store.slug || ''} ${store.name || ''}`)) {
        // Uokids' own store: its details move to its own settings, where it can edit them.
        const info = { ...(settings.store_info || {}) };
        if (taken.contact && !info.email && !info.phone && !info.address) {
          settings.store_info = { ...info, enabled: true, email: taken.contact.email || '', phone: taken.contact.phone || '', address: taken.contact.address || '' };
        }
        if (taken.whatsapp && !(settings.floating_whatsapp && settings.floating_whatsapp.phone)) {
          settings.floating_whatsapp = { enabled: true, phone: taken.whatsapp, message: '' };
        }
        if (taken.social && !Object.values(settings.social_links || {}).some(Boolean)) {
          settings.social_links = Object.fromEntries(taken.social.filter((s) => s && s.platform && s.url).map((s) => [s.platform, s.url]));
        }
      }
      await queryInterface.sequelize.query('UPDATE workspaces SET theme_settings = $ts::jsonb, settings = $settings::jsonb, updated_at = NOW() WHERE id = $id', {
        bind: { id: store.id, ts: JSON.stringify(ts), settings: JSON.stringify(settings) },
      });
    }
  },

  // The contact details of another store are not put back.
  down: async () => {},
};
