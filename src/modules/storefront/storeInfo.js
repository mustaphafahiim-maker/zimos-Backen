'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { NotFoundError } = require('../../core/errors/AppError');

/**
 * Store information and policies (SPEC §8.3, §8.5), both stored whole in the
 * workspace settings blob through PATCH /workspaces/:id.
 *
 * settings.store_info — contact details and three short policies (shipping,
 * returns, cash on delivery), each a title and bullet points. The storefront
 * shows them as trust cards under the buy button.
 *
 * settings.legal — the long policies: refund, privacy, terms of service.
 * Plain text, written once, linked from the store footer, every funnel and
 * the checkout. {{store.name}}, {{store.address}}, {{store.email}} and
 * {{store.phone}} are filled in when a policy is served, so a merchant who
 * changes their phone number does not have to edit three documents.
 *
 * Everything here is text the storefront prints as text — never markup.
 */

const LEGAL_KEYS = ['refund_policy', 'privacy_policy', 'terms_of_service'];
const CARD_KEYS = ['shipping_policy', 'return_policy', 'cod_policy'];

const card = Joi.object({
  enabled: Joi.boolean().optional(),
  title: Joi.string().trim().max(120).allow('', null).optional(),
  points: Joi.array().items(Joi.string().trim().min(1).max(200)).max(8).optional(),
});

const storeInfoSchema = Joi.object({
  enabled: Joi.boolean().required(),
  email: joiEmail().allow('', null).optional(),
  phone: Joi.string().trim().max(32).allow('', null).optional(),
  address: Joi.string().trim().max(300).allow('', null).optional(),
  shipping_policy: card.optional(),
  return_policy: card.optional(),
  cod_policy: card.optional(),
});

const legalSchema = Joi.object(
  Object.fromEntries(LEGAL_KEYS.map((key) => [key, Joi.string().trim().max(30000).allow('', null).optional()]))
);

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function resolveCard(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const points = Array.isArray(c.points) ? c.points.map(text).filter(Boolean) : [];
  return { enabled: c.enabled !== false, title: text(c.title), points };
}

/** The stored store_info with every key present. */
function resolveStoreInfo(settings) {
  const s = (settings && settings.store_info) || {};
  const out = { enabled: s.enabled === true, email: text(s.email), phone: text(s.phone), address: text(s.address) };
  for (const key of CARD_KEYS) out[key] = resolveCard(s[key]);
  return out;
}

/**
 * What the storefront may show: null while the merchant has it switched off,
 * and only the cards that are on and have something to say.
 */
function publicStoreInfo(settings) {
  const info = resolveStoreInfo(settings);
  if (!info.enabled) return null;
  const cards = CARD_KEYS.map((key) => ({ key, ...info[key] }))
    .filter((c) => c.enabled && (c.title || c.points.length > 0))
    .map(({ key, title, points }) => ({ key, title, points }));
  return { email: info.email, phone: info.phone, address: info.address, cards };
}

function fillVariables(body, workspace, info) {
  const values = {
    'store.name': workspace.name || '',
    'store.address': info.address,
    'store.email': info.email,
    'store.phone': info.phone,
  };
  return body.replace(/\{\{\s*(store\.(?:name|address|email|phone))\s*\}\}/g, (_, key) => values[key]);
}

/** Which long policies the store has written — the footer links exactly these. */
function publicLegalIndex(settings) {
  const legal = (settings && settings.legal) || {};
  return LEGAL_KEYS.filter((key) => text(legal[key]) !== '');
}

/**
 * One long policy as the shopper reads it, variables filled in.
 * @throws {NotFoundError} unknown key, or a policy the store has not written
 */
function publicLegalPolicy(workspace, key) {
  const legal = (workspace.settings && workspace.settings.legal) || {};
  const body = LEGAL_KEYS.includes(key) ? text(legal[key]) : '';
  if (!body) throw new NotFoundError('Policy');
  return { key, content: fillVariables(body, workspace, resolveStoreInfo(workspace.settings)) };
}

module.exports = {
  LEGAL_KEYS,
  storeInfoSchema,
  legalSchema,
  resolveStoreInfo,
  publicStoreInfo,
  publicLegalIndex,
  publicLegalPolicy,
};
