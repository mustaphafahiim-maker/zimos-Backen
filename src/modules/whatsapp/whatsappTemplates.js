'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');

/**
 * The store's WhatsApp message templates, synced from Meta with their status
 * (SPEC §14.1). Meta only sends a template it has approved for that account,
 * so the dashboard picks templates from this list (automations, the inbox),
 * and a send of a known template that is not APPROVED is refused before it
 * reaches Meta (WHATSAPP_TEMPLATE_NOT_APPROVED). A template the list does not
 * know is still sent as before — the list may simply not be synced yet.
 *
 * Synced on demand, after connecting, and kept current by Meta's
 * `message_template_status_update` webhook. The sandbox number answers with a
 * fixed list (whatsappSandbox.listTemplates).
 *
 *   GET  /workspaces/:id/whatsapp/templates[?status=APPROVED]
 *   POST /workspaces/:id/whatsapp/templates/sync
 */

const PROVIDER = 'whatsapp_cloud';

/** The highest {{n}} in a body: how many params a send fills. */
function paramsCountOf(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

const bodyOf = (components) => ((components || []).find((c) => String(c.type).toUpperCase() === 'BODY') || {}).text || null;

function view(t) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    rejectedReason: t.rejectedReason,
    bodyText: t.bodyText,
    paramsCount: t.paramsCount,
    buttons: ((t.components || []).find((c) => String(c.type).toUpperCase() === 'BUTTONS') || {}).buttons || [],
    syncedAt: t.syncedAt,
  };
}

async function connectedIntegration(workspaceId) {
  const integration = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER } });
  if (!integration || integration.status !== 'connected') {
    throw new AppError('WHATSAPP_NOT_CONNECTED', 'Connect WhatsApp in Settings → Integrations first', 422);
  }
  return integration;
}

/** Meta's list for this store, in Meta's shape. */
async function fetchFromMeta(integration) {
  const cfg = integration.config || {};
  if (!cfg.businessAccountId) {
    throw new AppError('WHATSAPP_NO_BUSINESS_ACCOUNT', 'Add your WhatsApp Business Account ID in the WhatsApp settings to sync templates', 422);
  }
  const { accessToken } = JSON.parse(secretBox.open(integration.secretsSealed) || '{}');
  return require('./whatsappCloud').listTemplates(cfg.businessAccountId, accessToken);
}

async function sync(workspaceId) {
  const integration = await connectedIntegration(workspaceId);
  const remote = await fetchFromMeta(integration);
  const now = new Date();
  const seen = [];
  await db.sequelize.transaction(async (transaction) => {
    for (const t of remote) {
      if (!t || !t.name || !t.language) continue;
      const body = bodyOf(t.components);
      const values = {
        workspaceId,
        metaId: t.id ? String(t.id) : null,
        name: String(t.name),
        language: String(t.language),
        category: t.category || null,
        status: String(t.status || 'PENDING').toUpperCase(),
        rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason).slice(0, 200) : null,
        bodyText: body,
        paramsCount: paramsCountOf(body),
        components: t.components || null,
        syncedAt: now,
      };
      const [row, created] = await db.WhatsappTemplate.findOrCreate({ where: { workspaceId, name: values.name, language: values.language }, defaults: values, transaction });
      if (!created) await row.update(values, { transaction });
      seen.push(row.id);
    }
    // Deleted in Meta: gone here too.
    await db.WhatsappTemplate.destroy({ where: { workspaceId, ...(seen.length ? { id: { [db.Sequelize.Op.notIn]: seen } } : {}) }, transaction });
  });
  return list(workspaceId);
}

/** After connecting: best effort, never throws. */
function syncQuietly(workspaceId) {
  return sync(workspaceId).catch((err) => logger.warn(`[whatsapp] template sync for ${workspaceId} failed: ${err.message}`));
}

async function list(workspaceId, { status } = {}) {
  const rows = await db.WhatsappTemplate.findAll({
    where: { workspaceId, ...(status ? { status } : {}) },
    order: [['name', 'ASC'], ['language', 'ASC']],
  });
  const last = rows.reduce((at, r) => (!at || r.syncedAt > at ? r.syncedAt : at), null);
  return { templates: rows.map(view), syncedAt: last };
}

/** Meta's message_template_status_update webhook change. */
async function onStatusUpdate(workspaceId, value) {
  if (!value || !value.event) return false;
  // By Meta's id, or by name and language (a row synced before Meta gave it an id).
  const { Op } = db.Sequelize;
  const byName = { name: String(value.message_template_name || ''), language: String(value.message_template_language || '') };
  const where = { workspaceId, [Op.or]: [...(value.message_template_id ? [{ metaId: String(value.message_template_id) }] : []), byName] };
  const [count] = await db.WhatsappTemplate.update(
    {
      status: String(value.event).toUpperCase(),
      rejectedReason: value.reason && value.reason !== 'NONE' ? String(value.reason).slice(0, 200) : null,
      syncedAt: new Date(),
    },
    { where }
  );
  return count > 0;
}

/** Before a template send: a known template must be APPROVED. */
async function assertSendable(workspaceId, template) {
  if (!template || !template.name) return;
  const known = await db.WhatsappTemplate.findOne({
    where: { workspaceId, name: template.name, ...(template.language ? { language: template.language } : {}) },
    attributes: ['status'],
  });
  if (known && known.status !== 'APPROVED') {
    throw new AppError('WHATSAPP_TEMPLATE_NOT_APPROVED', `The WhatsApp template "${template.name}" is ${known.status.toLowerCase()} in Meta, not approved`, 422);
  }
}

// ------------------------------------------------------------------ routes --
// Mounted on the staff WhatsApp router (whatsappRoutes.js), after authentication.

const router = Router({ mergeParams: true });
const ws = { workspaceId: Joi.string().uuid().required() };

router.get(
  '/templates',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().uppercase().max(30) }) }),
  asyncHandler(async (req, res) => res.json(await list(req.tenant.workspaceId, req.query)))
);
router.post(
  '/templates/sync',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json(await sync(req.tenant.workspaceId)))
);

module.exports = { sync, syncQuietly, list, onStatusUpdate, assertSendable, paramsCountOf, router };
