'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { requireCreationAllowed, requireLive } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const logger = require('../../core/utils/logger');
const db = require('../../db/models');

/*
 * Bulk actions on funnels (Lightfunnels' funnel list): publish, pause,
 * resume, duplicate or delete several funnels at once.
 *
 * Each funnel goes through exactly the path its own button takes
 * (funnelsService) — same checks, same audit rows, its own transaction — so
 * one funnel that cannot take the action never blocks the others. The
 * answer reports each funnel on its own: { funnelId, name, ok, error? }.
 *
 * Permissions follow the single actions: publish/pause/resume need
 * funnels.publish (publish and resume a live store), duplicate and delete
 * funnels.manage (duplicate is creation, refused on a restricted store).
 */

const MAX = 50;
const ACTIONS = {
  publish: (svc, ws, id, req) => svc.publishFunnel(ws, id, req.user.id, req.body.note || undefined, req),
  pause: (svc, ws, id, req) => svc.pauseFunnel(ws, id, req.user.id, req),
  resume: (svc, ws, id, req) => svc.resumeFunnel(ws, id, req.user.id, req),
  duplicate: (svc, ws, id, req) => svc.duplicateFunnel(ws, id, {}, req),
  delete: (svc, ws, id, req) => svc.deleteFunnel(ws, id, req),
};
const PUBLISHING = ['publish', 'pause', 'resume'];
const NEEDS_LIVE = ['publish', 'resume'];

async function run(workspaceId, { action, funnelIds }, req) {
  const svc = require('./funnelsService');
  const ids = [...new Set(funnelIds)];
  const names = new Map(
    (await db.Funnel.findAll({ where: { workspaceId, id: ids }, attributes: ['id', 'name'] })).map((f) => [f.id, f.name])
  );
  const results = [];
  for (const id of ids) {
    if (!names.has(id)) {
      results.push({ funnelId: id, name: null, ok: false, error: { code: 'NOT_FOUND', message: 'Funnel not found' } });
      continue;
    }
    try {
      const out = await ACTIONS[action](svc, workspaceId, id, req);
      const copy = action === 'duplicate' && out && (out.funnel || out);
      results.push({ funnelId: id, name: names.get(id), ok: true, ...(copy && copy.id ? { newFunnelId: copy.id } : {}) });
    } catch (err) {
      if (!err.isOperational) logger.error('Bulk funnel action failed unexpectedly', { workspaceId, funnelId: id, action, message: err.message });
      results.push({
        funnelId: id,
        name: names.get(id),
        ok: false,
        error: err.isOperational ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } : { code: 'INTERNAL_SERVER_ERROR', message: 'Unexpected error' },
      });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { action, total: results.length, succeeded, failed: results.length - succeeded, results };
}

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  body: Joi.object({
    action: Joi.string().valid(...Object.keys(ACTIONS)).required(),
    funnelIds: Joi.array().items(Joi.string().uuid()).min(1).max(MAX).required(),
    // publish only: the revision note, as on the single publish.
    note: Joi.string().max(500).allow('').optional(),
  }),
};

// The single actions' guards, picked by the action.
function guard(req, res, next) {
  const { action } = req.body;
  const chain = PUBLISHING.includes(action)
    ? [requirePermission(PERMISSIONS.FUNNELS_PUBLISH), ...(NEEDS_LIVE.includes(action) ? [requireLive] : [])]
    : [requirePermission(PERMISSIONS.FUNNELS_MANAGE), ...(action === 'duplicate' ? [requireCreationAllowed] : [])];
  const step = (i, err) => (err ? next(err) : i === chain.length ? next() : chain[i](req, res, (e) => step(i + 1, e)));
  step(0);
}

/** Registers POST /bulk on the staff funnels router (before the /:funnelId routes). */
function mount(router) {
  router.post('/bulk', validate(schema), guard, asyncHandler(async (req, res) => res.json(await run(req.tenant.workspaceId, req.body, req))));
}

module.exports = { mount, run, ACTIONS: Object.keys(ACTIONS), MAX };
