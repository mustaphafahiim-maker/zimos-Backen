'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const joiEmail = require('../../core/utils/joiEmail');
const { recordAudit } = require('../audit/auditService');

/**
 * Who the store's order emails are from (SPEC §14.5 "the 'From' email for
 * customers is in settings"): the sender name customers see — the store's
 * name unless the merchant sets another — and a Reply-To address, so a
 * customer's reply reaches the store and not the platform's sending address.
 * The sending address itself stays the platform's until the merchant's own
 * domain can be verified (out of scope, §14 boundary).
 *
 * Kept in workspace.settings.order_email_sender; no Reply-To unless set (the
 * owner's own email is not handed to customers by default).
 *
 *   GET /workspaces/:id/order-emails/sender
 *   PUT /workspaces/:id/order-emails/sender   { fromName, replyTo }
 */

const SETTINGS_KEY = 'order_email_sender';

function read(settings) {
  const s = (settings && settings[SETTINGS_KEY]) || {};
  return {
    fromName: typeof s.fromName === 'string' && s.fromName.trim() ? s.fromName.trim() : null,
    replyTo: typeof s.replyTo === 'string' && s.replyTo.trim() ? s.replyTo.trim() : null,
  };
}

/** What an order email's data carries for notify.email: the sender name and Reply-To. */
async function senderFor(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'settings'] });
  const own = read(workspace && workspace.settings);
  // A verified sending domain of the store's own replaces the platform's address (emailDomains/sendingDomain.js).
  const fromAddress = await require('../emailDomains/sendingDomain').fromAddressFor(workspaceId);
  return { fromName: own.fromName || (workspace ? workspace.name : ''), ...(own.replyTo ? { replyTo: own.replyTo } : {}), ...(fromAddress ? { fromAddress } : {}) };
}

async function get(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'settings'] });
  return { sender: read(workspace.settings), storeName: workspace.name };
}

async function set(workspaceId, { fromName, replyTo }, req) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  const before = read(workspace.settings);
  const next = { fromName: fromName ? String(fromName).trim() : null, replyTo: replyTo ? String(replyTo).trim().toLowerCase() : null };
  workspace.settings = { ...(workspace.settings || {}), [SETTINGS_KEY]: next };
  workspace.changed('settings', true);
  await workspace.save();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'order_email.sender_update', entityType: 'Workspace', entityId: workspaceId, before, after: next, req });
  return { sender: read(workspace.settings), storeName: workspace.name };
}

// Mounted on the order emails router (orderEmailRoutes.js) before its /:key routes.
const router = Router({ mergeParams: true });
const ws = { workspaceId: Joi.string().uuid().required() };
router.get('/sender', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await get(req.tenant.workspaceId))));
router.put(
  '/sender',
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      // Shown as the sender's name; quotes and angle brackets would break the From header.
      fromName: Joi.string().trim().max(70).pattern(/^[^"<>\r\n]*$/).allow('', null),
      replyTo: joiEmail().max(255).allow('', null),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await set(req.tenant.workspaceId, req.body, req)))
);

module.exports = { read, senderFor, get, set, router };
