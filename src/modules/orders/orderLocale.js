'use strict';

const db = require('../../db/models');
const { ValidationError } = require('../../core/errors/AppError');

/**
 * The language a customer reads their messages in (item 383).
 *
 * An order (and the checkout session before it) keeps the language the
 * shopper used the store in: the storefront sends it as `X-Store-Locale`, and
 * it counts only when it is one of the store's languages (`settings.store_languages`
 * plus the store's own, translations/translations.js) — anything else is the
 * store's default language. A staff order may name its `locale` (one the store
 * offers); without one it is the store's default. The order's emails, its
 * WhatsApp templates and the few built-in texts that exist in more than one
 * language follow `orders.locale`; an order from before it existed (null)
 * reads in the store's default language.
 */

const baseOf = (locale) => String(locale || '').trim().toLowerCase().split(/[-_]/)[0];

const languages = (workspace) => require('../translations/translations').languagesOf(workspace || {});

/** The offered language `asked` names, else the store's default. */
function pick(workspace, asked) {
  const { defaultLocale, languages: offered } = languages(workspace);
  const base = baseOf(asked);
  return offered.includes(base) ? base : defaultLocale;
}

/** The shopper's language from X-Store-Locale (a language the store offers), else the store's default. */
function fromRequest(workspace, req) {
  return pick(workspace, req && req.headers ? req.headers['x-store-locale'] : null);
}

/** Throws a 422 naming the store's languages when `locale` is not one of them; answers the base code. */
function assertOffered(workspace, locale, field = 'locale') {
  const { languages: offered } = languages(workspace);
  const base = baseOf(locale);
  if (!offered.includes(base)) {
    throw new ValidationError([{ field, message: `This store does not offer "${locale}". Its languages: ${offered.join(', ')}` }], 'Unsupported language');
  }
  return base;
}

const loadWorkspace = (workspaceId, transaction = null) =>
  db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'], transaction });

/**
 * A new order's language:
 *   payload.locale   named by staff or the API — must be one the store offers (422 otherwise)
 *   inherited        a follow-on order's (exchange, renewal, converted lost order) — kept when still offered
 *   X-Store-Locale   the shopper's, on a storefront order
 *   otherwise        the store's default language
 */
async function forNewOrder(workspaceId, payload, req, { inherited = null, transaction = null } = {}) {
  const workspace = await loadWorkspace(workspaceId, transaction);
  if (!workspace) return null;
  if (payload && payload.locale) return assertOffered(workspace, payload.locale);
  if (inherited) return pick(workspace, inherited);
  if (req && !req.user && req.headers && req.headers['x-store-locale']) return fromRequest(workspace, req);
  return languages(workspace).defaultLocale;
}

/** 'en' or 'ar' for the built-in texts that exist in those two: the order's language when it is one, else the store's. */
function textLang(locale, workspace) {
  const own = baseOf(locale);
  if (own === 'en' || own === 'ar') return own;
  return baseOf(workspace && workspace.defaultLocale) === 'en' ? 'en' : 'ar';
}

module.exports = { baseOf, pick, fromRequest, assertOffered, forNewOrder, textLang, loadWorkspace };
