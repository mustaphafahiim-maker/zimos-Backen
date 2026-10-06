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
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { TRANSLATION_LOCALES } = require('../translations/translations');

/**
 * Editable storefront texts (Lightfunnels' "Store texts"): the merchant
 * rewords the storefront's own labels — buttons, form errors, cart,
 * checkout and bundle wording — per language. The default wording lives in
 * the storefront's dictionary (zimos-front apps/storefront/src/lib/i18n.ts);
 * only the merchant's overrides are stored here, keyed by the dictionary
 * path ("checkout.placeOrder", "form.errors.summary").
 *
 *   settings.storefront_texts = { ar: { "section.key": "text" }, en: {…} }
 *
 * The texts are plain text (the storefront renders them as text, never as
 * HTML). `{name}` placeholders are kept as written for the storefront to
 * fill in. The storefront reads them in GET /store/:ws as `storefrontTexts`.
 */

const SETTINGS_KEY = 'storefront_texts';
const MAX_KEYS_PER_LOCALE = 400;
const MAX_TEXT = 500;
// section.key, up to four levels, camelCase segments as in the dictionary.
const KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39}){1,3}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function stored(workspace) {
  const value = workspace && workspace.settings && workspace.settings[SETTINGS_KEY];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Checks and cleans the merchant's texts: unknown languages, malformed keys
 * and too-long texts are refused (one error listing them); a blank text
 * drops the override, so the default wording shows again.
 */
function clean(input) {
  const problems = [];
  const out = {};
  for (const [locale, texts] of Object.entries(input || {})) {
    if (!TRANSLATION_LOCALES.includes(locale)) {
      problems.push({ path: locale, message: `Unknown language (one of ${TRANSLATION_LOCALES.join(', ')})` });
      continue;
    }
    if (!texts || typeof texts !== 'object' || Array.isArray(texts)) {
      problems.push({ path: locale, message: 'Must be an object of "section.key": "text"' });
      continue;
    }
    const kept = {};
    for (const [key, raw] of Object.entries(texts)) {
      if (!KEY_PATTERN.test(key)) {
        problems.push({ path: `${locale}.${key}`, message: 'Key must look like "section.key" (letters and digits, 2–4 parts)' });
        continue;
      }
      if (raw !== null && typeof raw !== 'string') {
        problems.push({ path: `${locale}.${key}`, message: 'Text must be a string' });
        continue;
      }
      const text = String(raw || '').replace(CONTROL, '').trim();
      if (!text) continue;
      if (text.length > MAX_TEXT) {
        problems.push({ path: `${locale}.${key}`, message: `Text can be at most ${MAX_TEXT} characters` });
        continue;
      }
      kept[key] = text;
    }
    if (Object.keys(kept).length > MAX_KEYS_PER_LOCALE) {
      problems.push({ path: locale, message: `At most ${MAX_KEYS_PER_LOCALE} texts per language` });
      continue;
    }
    if (Object.keys(kept).length) out[locale] = kept;
  }
  if (problems.length) throw new AppError('VALIDATION_ERROR', 'Some storefront texts are not valid', 422, problems);
  return out;
}

async function get(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  if (!workspace) throw new NotFoundError('Workspace');
  return stored(workspace);
}

async function replace(workspaceId, input, req) {
  const next = clean(input);
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    workspace.settings = { ...(workspace.settings || {}), [SETTINGS_KEY]: next };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    const counts = Object.fromEntries(Object.entries(next).map(([l, t]) => [l, Object.keys(t).length]));
    // Audited on the Workspace, so the storefront cache drops the store's copy.
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'storefront_texts.update', entityType: 'Workspace', entityId: workspaceId, metadata: { counts }, req, transaction });
    return next;
  });
}

const limits = { maxKeysPerLocale: MAX_KEYS_PER_LOCALE, maxText: MAX_TEXT, locales: TRANSLATION_LOCALES };

// Mounted at /api/v1/workspaces/:workspaceId/storefront-texts (website.edit: it is the store's wording).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });
router.get('/', validate({ params }), asyncHandler(async (req, res) => res.json({ texts: await get(req.tenant.workspaceId), limits })));
router.put(
  '/',
  validate({ params, body: Joi.object({ texts: Joi.object().pattern(Joi.string(), Joi.any()).required() }) }),
  asyncHandler(async (req, res) => res.json({ texts: await replace(req.tenant.workspaceId, req.body.texts, req), limits }))
);

module.exports = { router, get, clean, SETTINGS_KEY };
