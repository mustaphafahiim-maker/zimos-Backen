'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { NotFoundError } = require('../../core/errors/AppError');

/**
 * Saved views (SPEC §4.3): each teammate's own named filters for a list,
 * on the server so they follow them to any browser. Nobody sees another
 * person's views. A view is the list's query string; saving a name again
 * replaces it.
 *
 * Mounted at /api/v1/workspaces/:workspaceId/saved-views.
 */

const SCOPES = ['orders', 'lost_orders', 'customers', 'products'];
const MAX_PER_SCOPE = 30;
const ws = { workspaceId: Joi.string().uuid().required() };
const view = (v) => ({ id: v.id, scope: v.scope, name: v.name, query: v.query, updatedAt: v.updatedAt });

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get(
  '/',
  validate({ params: Joi.object(ws), query: Joi.object({ scope: Joi.string().valid(...SCOPES).required() }) }),
  asyncHandler(async (req, res) => {
    const views = await db.SavedView.findAll({
      where: { workspaceId: req.tenant.workspaceId, userId: req.user.id, scope: req.query.scope },
      order: [['name', 'ASC']],
    });
    res.json({ views: views.map(view) });
  })
);

router.post(
  '/',
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      scope: Joi.string().valid(...SCOPES).required(),
      name: Joi.string().trim().min(1).max(80).required(),
      query: Joi.string().max(4000).allow('').required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const owner = { workspaceId: req.tenant.workspaceId, userId: req.user.id, scope: req.body.scope };
    const existing = await db.SavedView.findOne({ where: { ...owner, name: req.body.name } });
    if (existing) {
      await existing.update({ query: req.body.query });
      return res.json({ view: view(existing) });
    }
    const count = await db.SavedView.count({ where: owner });
    if (count >= MAX_PER_SCOPE) {
      const { AppError } = require('../../core/errors/AppError'); // eslint-disable-line global-require
      throw new AppError('TOO_MANY_VIEWS', `Keep at most ${MAX_PER_SCOPE} saved views here — remove one first`, 409);
    }
    const created = await db.SavedView.create({ ...owner, name: req.body.name, query: req.body.query });
    return res.status(201).json({ view: view(created) });
  })
);

router.delete(
  '/:viewId',
  validate({ params: Joi.object({ ...ws, viewId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const removed = await db.SavedView.destroy({ where: { id: req.params.viewId, workspaceId: req.tenant.workspaceId, userId: req.user.id } });
    if (!removed) throw new NotFoundError('Saved view');
    res.status(204).end();
  })
);

module.exports = { router };
