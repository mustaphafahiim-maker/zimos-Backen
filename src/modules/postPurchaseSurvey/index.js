'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Post-purchase survey (spec-gaps item 236). settings.post_purchase_survey =
 *   { enabled, questions: [{ id, type: 'choice' | 'score' | 'text',
 *       text: { ar, en }, options: [{ id, label: { ar, en } }] (choice),
 *       allowOther (choice: a free-text "other"), required }] }   (≤ 3)
 * Shown on the thank-you page; nothing is sent to anyone. The shopper proves
 * the order is theirs with the order's tracking token (returned by checkout
 * as `trackingToken`), their sign-in, or an online order's payment token.
 * One answer set per order, changeable for 7 days. The team sees each
 * order's answers and a report: counts per option, the score average and
 * NPS (promoters 9–10 minus detractors 0–6), and the latest texts.
 */

const WINDOW_DAYS = 7;
const MAX_QUESTIONS = 3;

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.post_purchase_survey) || {};
  return { enabled: Boolean(s.enabled), questions: Array.isArray(s.questions) ? s.questions : [] };
}

/** The order, if this shopper may answer for it. */
async function ownedOrder(workspace, orderId, req) {
  const token = (req.body && req.body.token) || req.query.token;
  const shopperToken = req.headers['x-shopper-token'];
  try {
    return await require('../shopperAccounts/orderSelfService').orderFor(workspace, orderId, { shopperToken, trackingToken: token });
  } catch {
    /* try the payment token */
  }
  const paymentToken = req.headers['x-payment-token'];
  if (paymentToken) {
    const o = await require('../payments/onlinePaymentService').loadOrderForShopper(workspace.id, orderId, paymentToken).catch(() => null);
    if (o) return o;
  }
  throw new NotFoundError('Order');
}

function checkAnswers(questions, answers) {
  const out = {};
  const errors = [];
  for (const q of questions) {
    const a = answers[q.id];
    const empty = a === undefined || a === null || a === '';
    if (empty) {
      if (q.required) errors.push({ field: `answers.${q.id}`, message: 'Required' });
      continue;
    }
    if (q.type === 'score') {
      if (!Number.isInteger(a) || a < 0 || a > 10) errors.push({ field: `answers.${q.id}`, message: 'A score from 0 to 10' });
      else out[q.id] = a;
    } else if (q.type === 'choice') {
      if (typeof a === 'string' && (q.options || []).some((o) => o.id === a)) out[q.id] = a;
      else if (q.allowOther && a && typeof a === 'object' && typeof a.other === 'string' && a.other.trim()) out[q.id] = { other: a.other.trim().slice(0, 200) };
      else errors.push({ field: `answers.${q.id}`, message: 'Pick one of the options' });
    } else if (typeof a === 'string') {
      out[q.id] = a.trim().slice(0, 1000);
    } else {
      errors.push({ field: `answers.${q.id}`, message: 'Text' });
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}

// ------------------------------------------------------------- storefront --

// Mounted at /api/v1/store/:workspaceId/survey.
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace);
const publicQuestions = (s) => s.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.type === 'choice' ? q.options : undefined, allowOther: q.type === 'choice' ? Boolean(q.allowOther) : undefined, required: Boolean(q.required) }));

store.get('/', asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
  const s = settingsOf(w);
  if (!s.enabled || !s.questions.length) throw new NotFoundError('Survey');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ questions: publicQuestions(s) });
}));
const orderParams = Joi.object({ workspaceId: Joi.string().required(), orderId: Joi.string().uuid().required() });
store.get('/orders/:orderId', validate({ params: orderParams, query: Joi.object({ token: Joi.string().max(500) }) }), asyncHandler(async (req, res) => {
  const order = await ownedOrder(req.publicWorkspace, req.params.orderId, req);
  const r = await db.SurveyResponse.findByPk(order.id);
  res.set('Cache-Control', 'private, no-store');
  res.json({ answered: Boolean(r), answers: r ? r.answers : null, open: Date.now() - new Date(order.createdAt).getTime() < WINDOW_DAYS * 86400000 });
}));
store.put(
  '/orders/:orderId',
  validate({ params: orderParams, body: Joi.object({ token: Joi.string().max(500), answers: Joi.object().pattern(Joi.string().max(40), Joi.alternatives(Joi.string().max(1000).allow(''), Joi.number(), Joi.object({ other: Joi.string().max(200).required() }))).required() }) }),
  asyncHandler(async (req, res) => {
    const w = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
    const s = settingsOf(w);
    if (!s.enabled || !s.questions.length) throw new NotFoundError('Survey');
    const order = await ownedOrder(req.publicWorkspace, req.params.orderId, req);
    if (Date.now() - new Date(order.createdAt).getTime() > WINDOW_DAYS * 86400000) throw new AppError('SURVEY_CLOSED', 'This order can no longer be answered for', 409);
    const answers = checkAnswers(s.questions, req.body.answers);
    if (!Object.keys(answers).length) throw new ValidationError([{ field: 'answers', message: 'Answer at least one question' }]);
    await db.SurveyResponse.upsert({ orderId: order.id, workspaceId: w.id, answers });
    res.json({ answered: true, answers });
  })
);

// ----------------------------------------------------------------- staff --

// Mounted at /api/v1/workspaces/:workspaceId/post-purchase-survey.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const texts = Joi.object({ ar: Joi.string().trim().max(200).allow(''), en: Joi.string().trim().max(200).allow('') }).or('ar', 'en');
const question = Joi.object({
  id: Joi.string().trim().max(40).pattern(/^[A-Za-z0-9_-]+$/),
  type: Joi.string().valid('choice', 'score', 'text').required(),
  text: texts.required(),
  options: Joi.when('type', { is: 'choice', then: Joi.array().items(Joi.object({ id: Joi.string().trim().max(40).pattern(/^[A-Za-z0-9_-]+$/), label: texts.required() })).min(2).max(12).required(), otherwise: Joi.forbidden() }),
  allowOther: Joi.boolean().default(false),
  required: Joi.boolean().default(false),
});

staff.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] })));
}));
staff.put('/', requirePermission(PERMISSIONS.WORKSPACE_MANAGE), validate({ params: Joi.object(ws), body: Joi.object({ enabled: Joi.boolean().required(), questions: Joi.array().items(question).max(MAX_QUESTIONS).required() }) }), asyncHandler(async (req, res) => {
  const id = () => crypto.randomBytes(4).toString('hex');
  // Ids are kept on later saves, so answers keep pointing at their question and option.
  const questions = req.body.questions.map((q) => ({ ...q, id: q.id || id(), ...(q.type === 'choice' ? { options: q.options.map((o) => ({ ...o, id: o.id || id() })) } : {}) }));
  if (new Set(questions.map((q) => q.id)).size !== questions.length) throw new ValidationError([{ field: 'questions', message: 'Each question needs its own id' }]);
  if (req.body.enabled && !questions.length) throw new ValidationError([{ field: 'questions', message: 'Add a question' }]);
  const w = await db.Workspace.findByPk(req.tenant.workspaceId);
  await w.update({ settings: { ...(w.settings || {}), post_purchase_survey: { enabled: req.body.enabled, questions } } });
  await recordAudit({ workspaceId: w.id, actorUserId: req.user.id, action: 'post_purchase_survey.update', entityType: 'Workspace', entityId: w.id, after: { enabled: req.body.enabled, questions: questions.length }, req });
  res.json(settingsOf(w));
}));
staff.get('/orders/:orderId', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: Joi.object({ ...ws, orderId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const r = await db.SurveyResponse.findOne({ where: { orderId: req.params.orderId, workspaceId: req.tenant.workspaceId } });
  res.json({ answers: r ? r.answers : null, answeredAt: r ? r.createdAt : null });
}));
staff.get('/report', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ from: Joi.date().iso(), to: Joi.date().iso() }) }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  const s = settingsOf(w);
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 90 * 86400000);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const rows = await db.sequelize.query(
    `SELECT r.answers, r.created_at AS "createdAt", o.order_number AS "orderNumber" FROM survey_responses r JOIN orders o ON o.id = r.order_id
      WHERE r.workspace_id = :ws AND r.created_at BETWEEN :from AND :to ORDER BY r.created_at DESC LIMIT 20000`,
    { replacements: { ws: w.id, from, to }, type: QueryTypes.SELECT }
  );
  const questions = s.questions.map((q) => {
    const given = rows.map((r) => ({ a: r.answers[q.id], r })).filter((x) => x.a !== undefined);
    if (q.type === 'choice') {
      const counts = Object.fromEntries((q.options || []).map((o) => [o.id, 0]));
      let other = 0;
      for (const { a } of given) if (typeof a === 'string' && a in counts) counts[a] += 1; else if (a && a.other) other += 1;
      return { id: q.id, type: q.type, text: q.text, answers: given.length, options: (q.options || []).map((o) => ({ id: o.id, label: o.label, count: counts[o.id] })), other, otherTexts: given.filter((x) => x.a && x.a.other).slice(0, 20).map((x) => x.a.other) };
    }
    if (q.type === 'score') {
      const scores = given.map((x) => x.a).filter(Number.isInteger);
      const promoters = scores.filter((x) => x >= 9).length;
      const detractors = scores.filter((x) => x <= 6).length;
      return { id: q.id, type: q.type, text: q.text, answers: scores.length, average: scores.length ? Math.round((scores.reduce((n, x) => n + x, 0) / scores.length) * 10) / 10 : null, nps: scores.length ? Math.round(((promoters - detractors) / scores.length) * 100) : null, distribution: Array.from({ length: 11 }, (_, i) => scores.filter((x) => x === i).length) };
    }
    return { id: q.id, type: q.type, text: q.text, answers: given.length, latest: given.slice(0, 50).map((x) => ({ text: x.a, orderNumber: x.r.orderNumber, at: x.r.createdAt })) };
  });
  res.json({ from, to, responses: rows.length, questions });
}));

module.exports = { staff, store, settingsOf };
