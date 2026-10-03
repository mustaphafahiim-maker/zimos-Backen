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
const { AuthenticationError } = require('../../core/errors/AppError');
const service = require('./inboxService');
const inboxEvents = require('./inboxEvents');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const conversationParams = Joi.object({ ...ws, conversationId: uuid.required() });
const wid = (req) => req.tenant.workspaceId;

// Mounted at /api/v1/workspaces/:workspaceId/inbox. Same permission as the
// existing WhatsApp routes (orders.confirm): the people who talk to customers.
const router = Router({ mergeParams: true });

/**
 * The live stream, mounted on its own at /api/v1/inbox-stream/:workspaceId —
 * outside /workspaces, whose router demands a staff session on every path.
 * EventSource cannot send an Authorization header, so the stream is opened
 * with the one-minute ticket from POST …/inbox/stream-ticket instead; the
 * ticket names the store and the teammate, and both are checked again here.
 */
const stream = Router({ mergeParams: true });
stream.get(
  '/:workspaceId',
  validate({ params: Joi.object(ws), query: Joi.object({ ticket: Joi.string().max(400).required() }) }),
  asyncHandler(async (req, res) => {
    const ticket = inboxEvents.readTicket(req.query.ticket);
    if (!ticket || ticket.workspaceId !== req.params.workspaceId) throw new AuthenticationError('The stream ticket is missing or has expired');
    const membership = await db.Membership.findOne({
      where: { workspaceId: ticket.workspaceId, userId: ticket.userId, status: 'active' },
      include: [{ model: db.Role, as: 'role' }],
    });
    const permissions = membership ? membership.role.permissions : [];
    if (!permissions.includes('*') && !permissions.includes(PERMISSIONS.ORDERS_CONFIRM)) throw new AuthenticationError('The stream ticket is missing or has expired');
    await inboxEvents.stream(ticket.workspaceId, req, res);
  })
);

router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ORDERS_CONFIRM));

router.post(
  '/stream-ticket',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.status(201).json({ ticket: inboxEvents.issueTicket(wid(req), req.user.id), expiresInSeconds: inboxEvents.TICKET_TTL_MS / 1000 }))
);

router.get(
  '/conversations',
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      status: Joi.string().valid('open', 'closed'),
      assigned: Joi.string().valid('me', 'none'),
      unread: Joi.boolean().default(false),
      search: Joi.string().max(100).allow(''),
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await service.listConversations(wid(req), req.user.id, req.query)))
);

router.get('/assignees', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ assignees: await service.listAssignees(wid(req)) })));

router.put(
  '/conversations/:conversationId/assignee',
  validate({ params: conversationParams, body: Joi.object({ userId: uuid.allow(null).required() }) }),
  asyncHandler(async (req, res) => res.json({ conversation: await service.assign(wid(req), req.params.conversationId, req.body.userId, req) }))
);

router.get(
  '/conversations/:conversationId/customer',
  validate({ params: conversationParams }),
  asyncHandler(async (req, res) => res.json(await service.customerPanel(wid(req), req.params.conversationId)))
);

const quickReplyBody = { title: Joi.string().trim().min(1).max(80), body: Joi.string().trim().min(1).max(4096) };
const quickReplyParams = Joi.object({ ...ws, quickReplyId: uuid.required() });

router.get('/quick-replies', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.listQuickReplies(wid(req)))));
router.post(
  '/quick-replies',
  validate({ params: Joi.object(ws), body: Joi.object({ title: quickReplyBody.title.required(), body: quickReplyBody.body.required() }) }),
  asyncHandler(async (req, res) => res.status(201).json({ quickReply: await service.createQuickReply(wid(req), req.body, req) }))
);
router.patch(
  '/quick-replies/:quickReplyId',
  validate({ params: quickReplyParams, body: Joi.object(quickReplyBody).min(1) }),
  asyncHandler(async (req, res) => res.json({ quickReply: await service.updateQuickReply(wid(req), req.params.quickReplyId, req.body, req) }))
);
router.delete(
  '/quick-replies/:quickReplyId',
  validate({ params: quickReplyParams }),
  asyncHandler(async (req, res) => res.json(await service.deleteQuickReply(wid(req), req.params.quickReplyId, req)))
);

module.exports = router;
module.exports.stream = stream;
