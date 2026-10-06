'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const secretBox = require('../../../core/utils/secretBox');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const { AppError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const { countryOf } = require('../../../core/utils/storeCountry');
const { fold } = require('./fold');

/*
 * Address autocomplete at checkout (spec-gaps item 184; README.md here).
 * The shopper types; suggestions come from the store's provider; a pick
 * fills the address fields. Providers: `builtin` (the store's places list,
 * no key — the default and this interface's sandbox) and `google` (Places
 * API with the store's own key, sealed, never returned).
 *
 * A pick is matched back to the store's places list (region → city → area)
 * so delivery prices, hidden places and courier maps keep working: the
 * names become the list's names and `placeId` is set when a place matches.
 *
 * Setting: workspace_integrations row `address_autocomplete`,
 * config { provider: off|builtin|google }.
 */

const PROVIDERS = { builtin: require('./builtin'), google: require('./google') };
const KEY = 'address_autocomplete';
const DEFAULT = 'builtin';

const asAppError = (e) => (e instanceof AppError ? e : new AppError(e.code || 'ADDRESS_LOOKUP_UNAVAILABLE', e.message || 'The address service could not be reached', e.status || 502));

async function settingsOf(workspaceId) {
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: KEY } });
  const provider = (row && row.config && row.config.provider) || DEFAULT;
  return { row, provider, credentials: row && row.secretsSealed ? JSON.parse(secretBox.open(row.secretsSealed)) : null };
}

const view = ({ row, provider, credentials }) => ({
  provider,
  providers: Object.values(PROVIDERS).map((p) => ({ code: p.code, name: p.name, needsKey: p.needsKey })),
  hasKey: Boolean(credentials && credentials.apiKey),
  lastError: row ? row.lastError : null,
});

async function getSettings(workspaceId) {
  return view(await settingsOf(workspaceId));
}

async function updateSettings(workspaceId, { provider, apiKey }, req) {
  const current = await settingsOf(workspaceId);
  let credentials = current.credentials;
  if (apiKey) credentials = { apiKey };
  if (provider === 'google') {
    if (!credentials || !credentials.apiKey) throw new AppError('ADDRESS_LOOKUP_KEY_REQUIRED', 'Add your Google API key', 422, [{ field: 'apiKey', message: 'Required for Google' }]);
    // A new key is tried once before it is kept.
    if (apiKey) {
      try {
        await PROVIDERS.google.verify(credentials);
      } catch (e) {
        throw asAppError(e);
      }
    }
  }
  const values = { status: 'connected', config: { provider }, secretsSealed: credentials ? secretBox.seal(JSON.stringify(credentials)) : null, lastError: null, lastVerifiedAt: new Date() };
  const row = current.row ? await current.row.update(values) : await db.WorkspaceIntegration.create({ workspaceId, provider: KEY, ...values });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'address_autocomplete.update', entityType: 'WorkspaceIntegration', entityId: row.id, before: { provider: current.provider }, after: { provider, keyChanged: Boolean(apiKey) }, req });
  return view({ row, provider, credentials });
}

/** The provider's address → the store's own place names and id where they match. */
async function matchToPlaces(workspace, address) {
  if (!address || address.placeId) return address;
  const { places, source } = await require('../storePlaces').publicPlaces(workspace, address.country);
  const same = (node, name) => name && (fold(node.ar) === fold(name) || (node.en && fold(node.en) === fold(name)));
  const region = places.find((r) => same(r, address.province));
  const cities = region ? region.children || [] : places.flatMap((r) => r.children || []);
  const city = cities.find((c) => same(c, address.city));
  const area = city ? (city.children || []).find((a) => same(a, address.area)) : null;
  const regionOf = region || (city ? places.find((r) => (r.children || []).includes(city)) : null);
  const deepest = area || city || regionOf;
  return {
    ...address,
    province: regionOf ? regionOf.ar : address.province,
    city: city ? city.ar : address.city,
    area: area ? area.ar : address.area,
    placeId: source === 'store' && deepest && deepest.id ? deepest.id : null,
  };
}

async function publicConfig(workspace) {
  const { provider } = await settingsOf(workspace.id);
  return { enabled: provider !== 'off', provider: provider === 'off' ? null : provider, attribution: provider === 'off' ? null : PROVIDERS[provider].attribution };
}

async function run(workspace, fn) {
  const s = await settingsOf(workspace.id);
  if (s.provider === 'off') return null;
  const provider = PROVIDERS[s.provider];
  try {
    return await fn(provider, s.credentials || {});
  } catch (e) {
    // A refused key stops Google from answering: say so to the merchant, and fall back to the store's list for the shopper.
    if (s.row && e.code === 'ADDRESS_LOOKUP_INVALID_KEY') await s.row.update({ lastError: e.message });
    if (provider.code !== 'builtin' && e.code) return fn(PROVIDERS.builtin, {});
    throw asAppError(e);
  }
}

async function suggest(workspace, { q, country, lang, session }) {
  const out = await run(workspace, (p, credentials) => p.suggest({ workspace, credentials, country, q, lang, session }));
  return { enabled: out !== null, suggestions: out || [] };
}

async function details(workspace, { id, country, lang, session }) {
  const s = await settingsOf(workspace.id);
  if (s.provider === 'off') throw new AppError('ADDRESS_LOOKUP_OFF', 'Address suggestions are off for this store', 404);
  // A store-list id is always read from the list, whichever provider suggested it.
  const provider = /^(p|g):/.test(id) ? PROVIDERS.builtin : String(id).startsWith('google:') ? PROVIDERS.google : null;
  if (!provider) throw new AppError('ADDRESS_NOT_FOUND', 'That suggestion was not found', 404);
  let address;
  try {
    address = await provider.details({ workspace, credentials: s.credentials || {}, country, id, lang, session });
  } catch (e) {
    throw asAppError(e);
  }
  if (!address) throw new AppError('ADDRESS_NOT_FOUND', 'That suggestion was not found', 404);
  return { address: await matchToPlaces(workspace, address) };
}

// ----------------------------------------------------------------- routes --

const countryParam = (req) => String(req.query.country || countryOf(req.publicWorkspace) || 'EG').toUpperCase();
const langParam = (req) => (['ar', 'en', 'fr'].includes(req.query.lang) ? req.query.lang : req.publicWorkspace.defaultLocale === 'en' ? 'en' : 'ar');
const country = Joi.string().pattern(/^[A-Za-z]{2}$/);
const session = Joi.string().pattern(/^[A-Za-z0-9_-]{8,64}$/);
const lang = Joi.string().valid('ar', 'en', 'fr');
const storeParams = Joi.object({ workspaceId: Joi.string().required() });

// Mounted at /api/v1/store/:workspaceId/address.
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace);
store.get('/config', validate({ params: storeParams }), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await publicConfig(req.publicWorkspace));
}));
store.get(
  '/suggest',
  validate({ params: storeParams, query: Joi.object({ q: Joi.string().trim().min(2).max(120).required(), country, lang, session }) }),
  asyncHandler(async (req, res) => res.json(await suggest(req.publicWorkspace, { q: req.query.q, country: countryParam(req), lang: langParam(req), session: req.query.session })))
);
store.get(
  '/details',
  validate({ params: storeParams, query: Joi.object({ id: Joi.string().trim().min(3).max(320).required(), country, lang, session }) }),
  asyncHandler(async (req, res) => res.json(await details(req.publicWorkspace, { id: req.query.id, country: countryParam(req), lang: langParam(req), session: req.query.session })))
);

// Mounted at /api/v1/workspaces/:workspaceId/address-autocomplete (shipping.manage, like the places list).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };
staff.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await getSettings(req.tenant.workspaceId))));
staff.put(
  '/',
  validate({
    params: Joi.object(ws),
    body: Joi.object({ provider: Joi.string().valid('off', ...Object.keys(PROVIDERS)).required(), apiKey: Joi.string().trim().min(20).max(200).optional() }),
  }),
  asyncHandler(async (req, res) => res.json(await updateSettings(req.tenant.workspaceId, req.body, req)))
);

module.exports = { store, staff, suggest, details, matchToPlaces };
