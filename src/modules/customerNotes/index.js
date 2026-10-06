'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AuthorizationError, NotFoundError, ValidationError } = require('../../core/errors/AppError');

/*
 * Notes and follow-ups on customers (spec-gaps item 209).
 *
 * - Notes: staff write notes on a contact (author and time kept); pinned ones
 *   come first. Only the author (or someone with customers.manage) edits or
 *   deletes a note.
 * - Follow-ups: "call back about the wholesale order" — due at a time,
 *   assigned to a teammate who can see customers. When one falls due the
 *   assignee gets a `customer.followup` notification (bell, and email by
 *   default), once. "My follow-ups" lists what is open, overdue first.
 */

const canView = requirePermission(PERMISSIONS.CUSTOMERS_VIEW);
const canManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);

async function customerOf(workspaceId, id) {
  const c = await db.Customer.findOne({ where: { id, workspaceId }, attributes: ['id', 'fullName', 'phoneNormalized'] });
  if (!c) throw new NotFoundError('Customer');
  return c;
}

const noteView = (n) => ({ id: n.id, customerId: n.customerId, body: n.body, isPinned: n.isPinned, author: n.author ? { id: n.author.id, fullName: n.author.fullName } : n.authorUserId ? { id: n.authorUserId } : null, createdAt: n.createdAt, updatedAt: n.updatedAt });
const followupView = (f) => ({
  id: f.id, customerId: f.customerId, customer: f.customer ? { id: f.customer.id, fullName: f.customer.fullName, phone: f.customer.phoneNormalized } : undefined,
  title: f.title, dueAt: f.dueAt, doneAt: f.doneAt, overdue: !f.doneAt && new Date(f.dueAt) < new Date(),
  assignee: f.assignee ? { id: f.assignee.id, fullName: f.assignee.fullName } : f.assigneeUserId ? { id: f.assigneeUserId } : null, createdBy: f.createdBy, createdAt: f.createdAt,
});

async function assertAssignee(workspaceId, userId) {
  if (!userId) return;
  const m = await db.Membership.findOne({ where: { workspaceId, userId, status: 'active' }, include: [{ model: db.Role, as: 'role', attributes: ['permissions'] }] });
  if (!m || !(m.role.permissions.includes('*') || m.role.permissions.includes(PERMISSIONS.CUSTOMERS_VIEW))) {
    throw new ValidationError([{ field: 'assigneeUserId', message: 'Assign it to a teammate who can see customers' }]);
  }
}

/** The schedule: follow-ups that just fell due tell their assignee, once. */
async function notifyDue() {
  const due = await db.CustomerFollowup.findAll({ where: { doneAt: null, notifiedAt: null, dueAt: { [Op.lte]: new Date() } }, include: [{ model: db.Customer, as: 'customer', attributes: ['id', 'fullName'] }], limit: 500 });
  for (const f of due) {
    try {
      const [claimed] = await db.CustomerFollowup.update({ notifiedAt: new Date() }, { where: { id: f.id, notifiedAt: null } });
      if (!claimed) continue;
      const name = (f.customer && f.customer.fullName) || '';
      await require('../notifications/merchantNotificationService').create(f.workspaceId, {
        type: 'customer.followup',
        title: `متابعة: ${f.title}`,
        body: name ? `مع ${name}` : null,
        link: `/customers/${f.customerId}`,
        data: { followupId: f.id, customerId: f.customerId, customerName: name, title: f.title },
        dedupeKey: `followup:${f.id}`,
        userIds: f.assigneeUserId ? [f.assigneeUserId] : null,
        localized: { en: { title: `Follow-up: ${f.title}`, body: name ? `with ${name}` : null }, ar: { title: `متابعة: ${f.title}`, body: name ? `مع ${name}` : null } },
      });
    } catch (err) {
      logger.error(`[customerNotes] follow-up ${f.id}: ${err.message}`);
    }
  }
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/workspaces/:workspaceId/customer-notes.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const cust = Joi.object({ ...ws, customerId: Joi.string().uuid().required() });

router.get('/customers/:customerId', canView, validate({ params: cust }), asyncHandler(async (req, res) => {
  await customerOf(req.tenant.workspaceId, req.params.customerId);
  const [notes, followups] = await Promise.all([
    db.CustomerNote.findAll({ where: { customerId: req.params.customerId, workspaceId: req.tenant.workspaceId }, include: [{ model: db.User, as: 'author', attributes: ['id', 'fullName'] }], order: [['isPinned', 'DESC'], ['createdAt', 'DESC']], limit: 500 }),
    db.CustomerFollowup.findAll({ where: { customerId: req.params.customerId, workspaceId: req.tenant.workspaceId }, include: [{ model: db.User, as: 'assignee', attributes: ['id', 'fullName'] }], order: [['doneAt', 'DESC NULLS FIRST'], ['dueAt', 'ASC']], limit: 200 }),
  ]);
  res.json({ notes: notes.map(noteView), followups: followups.map(followupView) });
}));

router.post('/customers/:customerId/notes', canView, validate({ params: cust, body: Joi.object({ body: Joi.string().trim().min(1).max(5000).required(), isPinned: Joi.boolean() }) }), asyncHandler(async (req, res) => {
  await customerOf(req.tenant.workspaceId, req.params.customerId);
  const n = await db.CustomerNote.create({ workspaceId: req.tenant.workspaceId, customerId: req.params.customerId, authorUserId: req.user.id, body: req.body.body, isPinned: Boolean(req.body.isPinned) });
  n.author = { id: req.user.id, fullName: req.user.fullName };
  res.status(201).json(noteView(n));
}));
const noteP = Joi.object({ ...ws, noteId: Joi.string().uuid().required() });
async function ownNote(req) {
  const n = await db.CustomerNote.findOne({ where: { id: req.params.noteId, workspaceId: req.tenant.workspaceId } });
  if (!n) throw new NotFoundError('Note');
  if (n.authorUserId !== req.user.id && !req.tenant.hasPermission(PERMISSIONS.CUSTOMERS_MANAGE)) throw new AuthorizationError('Only the author can change this note');
  return n;
}
router.patch('/notes/:noteId', canView, validate({ params: noteP, body: Joi.object({ body: Joi.string().trim().min(1).max(5000), isPinned: Joi.boolean() }).min(1) }), asyncHandler(async (req, res) => {
  const n = await ownNote(req);
  await n.update(req.body);
  res.json(noteView(n));
}));
router.delete('/notes/:noteId', canView, validate({ params: noteP }), asyncHandler(async (req, res) => {
  const n = await ownNote(req);
  await n.destroy();
  res.status(204).end();
}));

const fuFields = { title: Joi.string().trim().min(1).max(200), dueAt: Joi.date().iso(), assigneeUserId: Joi.string().uuid().allow(null) };
router.post('/customers/:customerId/followups', canView, validate({ params: cust, body: Joi.object({ ...fuFields, title: fuFields.title.required(), dueAt: fuFields.dueAt.required() }) }), asyncHandler(async (req, res) => {
  await customerOf(req.tenant.workspaceId, req.params.customerId);
  const assignee = req.body.assigneeUserId === undefined ? req.user.id : req.body.assigneeUserId;
  await assertAssignee(req.tenant.workspaceId, assignee);
  const f = await db.CustomerFollowup.create({ workspaceId: req.tenant.workspaceId, customerId: req.params.customerId, assigneeUserId: assignee, createdBy: req.user.id, title: req.body.title, dueAt: req.body.dueAt });
  res.status(201).json(followupView(f));
}));
const fuP = Joi.object({ ...ws, followupId: Joi.string().uuid().required() });
router.patch('/followups/:followupId', canView, validate({ params: fuP, body: Joi.object({ ...fuFields, done: Joi.boolean() }).min(1) }), asyncHandler(async (req, res) => {
  const f = await db.CustomerFollowup.findOne({ where: { id: req.params.followupId, workspaceId: req.tenant.workspaceId } });
  if (!f) throw new NotFoundError('Follow-up');
  if (req.body.assigneeUserId !== undefined) await assertAssignee(req.tenant.workspaceId, req.body.assigneeUserId);
  const { done, ...rest } = req.body;
  await f.update({
    ...rest,
    ...(done !== undefined ? { doneAt: done ? new Date() : null } : {}),
    // A new time or assignee is reminded again.
    ...(rest.dueAt !== undefined || rest.assigneeUserId !== undefined ? { notifiedAt: null } : {}),
  });
  res.json(followupView(f));
}));
router.delete('/followups/:followupId', canManage, validate({ params: fuP }), asyncHandler(async (req, res) => {
  const n = await db.CustomerFollowup.destroy({ where: { id: req.params.followupId, workspaceId: req.tenant.workspaceId } });
  if (!n) throw new NotFoundError('Follow-up');
  res.status(204).end();
}));
// Open follow-ups: mine by default, everyone's with ?all=true; overdue first.
router.get('/followups', canView, validate({ params: Joi.object(ws), query: Joi.object({ all: Joi.boolean(), dueBefore: Joi.date().iso() }) }), asyncHandler(async (req, res) => {
  const where = { workspaceId: req.tenant.workspaceId, doneAt: null, ...(req.query.all ? {} : { assigneeUserId: req.user.id }), ...(req.query.dueBefore ? { dueAt: { [Op.lte]: new Date(req.query.dueBefore) } } : {}) };
  const rows = await db.CustomerFollowup.findAll({ where, include: [{ model: db.Customer, as: 'customer', attributes: ['id', 'fullName', 'phoneNormalized'] }, { model: db.User, as: 'assignee', attributes: ['id', 'fullName'] }], order: [['dueAt', 'ASC']], limit: 500 });
  res.json({ followups: rows.map(followupView), overdue: rows.filter((f) => new Date(f.dueAt) < new Date()).length });
}));

module.exports = { router, notifyDue };
