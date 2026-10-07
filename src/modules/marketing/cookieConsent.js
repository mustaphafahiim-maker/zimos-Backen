'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');

/*
 * Cookie consent (spec-gaps item 196). settings.cookie_consent =
 *   { mode: off | notice | opt_in, countries: null | ['DE', …], policyUrl,
 *     texts: { ar|en|fr: { message, accept, reject } } }
 *
 *   off      no banner (the default; the store as it was)
 *   notice   a banner that informs; tracking runs
 *   opt_in   nothing tracks until the shopper accepts: the storefront loads
 *            no pixels before, and the server sends no ad-platform events
 *            (browser relay and purchase events) for a shopper who did not
 *            accept. `countries`: only visitors from these countries are
 *            asked (null = everyone); an unknown country is asked.
 *
 * The storefront sends `consent: { marketing: true|false }` with its event
 * batches and `trackingConsent` with the checkout (kept on the order).
 */

const MODES = ['off', 'notice', 'opt_in'];

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.cookie_consent) || {};
  return {
    mode: MODES.includes(s.mode) ? s.mode : 'off',
    countries: Array.isArray(s.countries) && s.countries.length ? s.countries : null,
    policyUrl: s.policyUrl || null,
    texts: s.texts && typeof s.texts === 'object' ? s.texts : {},
  };
}

/** Whether a visitor from `country` must accept before ad tracking. */
function asks(settings, country) {
  if (settings.mode !== 'opt_in') return false;
  if (!settings.countries) return true;
  return !country || settings.countries.includes(String(country).toUpperCase());
}

async function countryOfIp(ip) {
  if (!ip) return null;
  const intel = await require('../risk/ipIntel').lookup(ip).catch(() => null);
  return intel && intel.country ? String(intel.country).toUpperCase() : null;
}

/** The browser relay: may this batch go to the ad platforms? */
async function relayAllowed(workspaceId, body, clientIp) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const s = settingsOf(workspace);
  if (s.mode !== 'opt_in') return true;
  if (body && body.consent && body.consent.marketing === true) return true;
  return !asks(s, s.countries ? await countryOfIp(clientIp) : null);
}

/** A purchase event: did the order's shopper allow it? */
function orderAllowed(workspace, order) {
  const s = settingsOf(workspace);
  if (s.mode !== 'opt_in') return true;
  const consent = order.attribution && order.attribution.consent;
  if (consent && consent.marketing === true) return true;
  return !asks(s, order.ipCountry);
}

/** Checkout: keeps the shopper's answer on the order (never throws). */
async function recordOnOrder(order, trackingConsent) {
  if (typeof trackingConsent !== 'boolean') return;
  try {
    // Merged in SQL (item 311): the attribution capture may have filled the touches meanwhile.
    const consent = { marketing: trackingConsent, at: new Date().toISOString() };
    await db.sequelize.query("UPDATE orders SET attribution = COALESCE(attribution, '{}'::jsonb) || jsonb_build_object('consent', CAST(:consent AS jsonb)) WHERE id = :id", { replacements: { id: order.id, consent: JSON.stringify(consent) } });
    order.attribution = { ...(order.attribution || {}), consent };
  } catch {
    /* the order stands without it */
  }
}

/** For GET /store/:ws. */
function publicView(workspace) {
  const s = settingsOf(workspace);
  return s.mode === 'off' ? { mode: 'off' } : s;
}

// Mounted at /api/v1/workspaces/:workspaceId/cookie-consent (website.edit).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
const text = Joi.object({ message: Joi.string().trim().max(500).allow(''), accept: Joi.string().trim().max(40).allow(''), reject: Joi.string().trim().max(40).allow('') });
router.get('/', validate({ params: ws }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] })))));
router.put(
  '/',
  validate({
    params: ws,
    body: Joi.object({
      mode: Joi.string().valid(...MODES).required(),
      countries: Joi.array().items(Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/)).max(250).unique().allow(null),
      policyUrl: Joi.alternatives().try(Joi.string().trim().uri({ scheme: ['https'] }), Joi.string().trim().pattern(/^\/[^\s]{0,300}$/)).allow(null, ''),
      texts: Joi.object({ ar: text, en: text, fr: text }),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = settingsOf(workspace);
    const next = { mode: req.body.mode, countries: req.body.countries || null, policyUrl: req.body.policyUrl || null, texts: req.body.texts || before.texts };
    await workspace.update({ settings: { ...(workspace.settings || {}), cookie_consent: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'cookie_consent.update', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    res.json(settingsOf(workspace));
  })
);

module.exports = { router, settingsOf, asks, relayAllowed, orderAllowed, recordOnOrder, publicView };
