'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');

/*
 * Customer timeline (spec-gaps item 250): everything that happened with one
 * customer, newest first, in one feed — read from the tables that already
 * hold it, nothing new is stored:
 *   order_placed, order_shipped, order_delivered, order_cancelled,
 *   return_requested, refund, note, followup, review, question (asked from
 *   the customer's email), loyalty, store_credit, quote, privacy_request,
 *   referral (a friend they referred), form (a form they sent).
 * Paged with a cursor (`next`), so new events at the top don't shift pages;
 * `kinds` narrows the feed.
 */

const KINDS = ['order_placed', 'order_shipped', 'order_delivered', 'order_cancelled', 'return_requested', 'refund', 'note', 'followup',
  'review', 'question', 'loyalty', 'store_credit', 'quote', 'privacy_request', 'referral', 'form'];

// Each source: kind, at, id (text), order id/number when there is one, data.
const SOURCES = {
  order_placed: `SELECT 'order_placed' AS kind, o.created_at AS at, o.id::text AS id, o.id AS order_id, o.order_number,
      jsonb_build_object('total', o.total_amount::text, 'currency', o.currency, 'paymentMethod', o.payment_method, 'source', o.source, 'isTest', o.is_test) AS data
    FROM orders o WHERE o.workspace_id = :ws AND o.customer_id = :c`,
  order_shipped: `SELECT 'order_shipped', s.shipped_at, s.id::text, o.id, o.order_number,
      jsonb_build_object('carrier', s.carrier_code, 'waybill', s.waybill_number, 'trackingUrl', s.tracking_url)
    FROM shipments s JOIN orders o ON o.id = s.order_id WHERE o.workspace_id = :ws AND o.customer_id = :c AND s.shipped_at IS NOT NULL`,
  order_delivered: `SELECT 'order_delivered', s.delivered_at, s.id::text, o.id, o.order_number,
      jsonb_build_object('carrier', s.carrier_code, 'waybill', s.waybill_number)
    FROM shipments s JOIN orders o ON o.id = s.order_id WHERE o.workspace_id = :ws AND o.customer_id = :c AND s.delivered_at IS NOT NULL`,
  order_cancelled: `SELECT 'order_cancelled', o.cancelled_at, o.id::text, o.id, o.order_number,
      jsonb_build_object('reason', o.cancellation_reason)
    FROM orders o WHERE o.workspace_id = :ws AND o.customer_id = :c AND o.cancelled_at IS NOT NULL`,
  return_requested: `SELECT 'return_requested', r.created_at, r.id::text, o.id, o.order_number,
      jsonb_build_object('reason', r.reason, 'status', r.status, 'items', r.items)
    FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE o.workspace_id = :ws AND o.customer_id = :c`,
  refund: `SELECT 'refund', r.created_at, r.id::text, o.id, o.order_number,
      jsonb_build_object('amount', r.amount::text, 'currency', o.currency, 'status', r.status, 'reason', r.reason)
    FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.workspace_id = :ws AND o.customer_id = :c`,
  note: `SELECT 'note', n.created_at, n.id::text, NULL::uuid, NULL,
      jsonb_build_object('body', n.body, 'pinned', n.is_pinned, 'author', u.full_name)
    FROM customer_notes n LEFT JOIN users u ON u.id = n.author_user_id WHERE n.workspace_id = :ws AND n.customer_id = :c`,
  followup: `SELECT 'followup', f.created_at, f.id::text, NULL::uuid, NULL,
      jsonb_build_object('title', f.title, 'dueAt', f.due_at, 'doneAt', f.done_at, 'assignee', u.full_name)
    FROM customer_followups f LEFT JOIN users u ON u.id = f.assignee_user_id WHERE f.workspace_id = :ws AND f.customer_id = :c`,
  review: `SELECT 'review', r.created_at, r.id::text, r.order_id, o.order_number,
      jsonb_build_object('rating', r.rating, 'comment', r.comment, 'status', r.status, 'productId', r.product_id, 'product', p.name)
    FROM reviews r LEFT JOIN products p ON p.id = r.product_id LEFT JOIN orders o ON o.id = r.order_id WHERE r.workspace_id = :ws AND r.customer_id = :c`,
  question: `SELECT 'question', q.created_at, q.id::text, NULL::uuid, NULL,
      jsonb_build_object('question', q.question, 'answer', q.answer, 'status', q.status, 'productId', q.product_id, 'product', p.name)
    FROM product_questions q LEFT JOIN products p ON p.id = q.product_id
    WHERE q.workspace_id = :ws AND :email <> '' AND lower(q.asker_email) = :email`,
  loyalty: `SELECT 'loyalty', t.created_at, t.id::text, t.order_id, o.order_number,
      jsonb_build_object('kind', t.kind, 'points', t.points, 'balanceAfter', t.balance_after, 'note', t.note)
    FROM loyalty_transactions t LEFT JOIN orders o ON o.id = t.order_id WHERE t.workspace_id = :ws AND t.customer_id = :c`,
  store_credit: `SELECT 'store_credit', t.created_at, t.id::text, t.order_id, o.order_number,
      jsonb_build_object('kind', t.kind, 'amount', t.amount::text, 'balanceAfter', t.balance_after::text, 'currency', t.currency, 'note', t.note)
    FROM store_credit_transactions t LEFT JOIN orders o ON o.id = t.order_id WHERE t.workspace_id = :ws AND t.customer_id = :c`,
  quote: `SELECT 'quote', q.created_at, q.id::text, q.order_id, o.order_number,
      jsonb_build_object('number', q.number, 'status', q.status, 'currency', q.currency, 'validUntil', q.valid_until)
    FROM quote_requests q LEFT JOIN orders o ON o.id = q.order_id WHERE q.workspace_id = :ws AND q.customer_id = :c`,
  privacy_request: `SELECT 'privacy_request', p.created_at, p.id::text, NULL::uuid, NULL,
      jsonb_build_object('kind', p.kind, 'status', p.status, 'completedAt', p.completed_at)
    FROM privacy_requests p WHERE p.workspace_id = :ws AND p.customer_id = :c`,
  referral: `SELECT 'referral', r.created_at, r.id::text, r.order_id, o.order_number,
      jsonb_build_object('status', r.status, 'friend', f.full_name, 'rewardedAt', r.rewarded_at)
    FROM customer_referrals r LEFT JOIN customers f ON f.id = r.friend_customer_id LEFT JOIN orders o ON o.id = r.order_id
    WHERE r.workspace_id = :ws AND r.referrer_customer_id = :c`,
  form: `SELECT 'form', s.created_at, s.id::text, NULL::uuid, NULL,
      jsonb_build_object('form', s.form_name, 'page', s.page_path, 'message', s.message)
    FROM form_submissions s WHERE s.workspace_id = :ws AND s.customer_id = :c`,
};

const encode = (row) => Buffer.from(`${row.atKey}|${row.kind}|${row.id}`).toString('base64url');
function decode(cursor) {
  const [at, kind, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !kind || !id || Number.isNaN(Date.parse(at))) throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }]);
  return { at, kind, id };
}

async function timeline(workspaceId, customer, { kinds, limit, cursor }) {
  const parts = (kinds && kinds.length ? kinds : KINDS).map((k) => SOURCES[k]);
  const after = cursor ? decode(cursor) : null;
  const rows = await db.sequelize.query(
    `SELECT kind, at, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "atKey", id,
            order_id AS "orderId", order_number AS "orderNumber", data
       FROM (${parts.join('\nUNION ALL\n')}) e (kind, at, id, order_id, order_number, data)
      WHERE at IS NOT NULL ${after ? 'AND (at, kind, id) < (:cat::timestamptz, :ckind, :cid)' : ''}
      ORDER BY at DESC, kind DESC, id DESC
      LIMIT :lim`,
    { replacements: { ws: workspaceId, c: customer.id, email: (customer.email || '').trim().toLowerCase(), lim: limit + 1, cat: after && after.at, ckind: after && after.kind, cid: after && after.id }, type: QueryTypes.SELECT }
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    events: page.map(({ atKey, ...e }) => e),
    next: more ? encode(page[page.length - 1]) : null,
  };
}

// Mounted at /api/v1/workspaces/:workspaceId/customers/:customerId/timeline (customers.view).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.CUSTOMERS_VIEW));

router.get('/', validate({
  params: Joi.object({ workspaceId: Joi.string().uuid().required(), customerId: Joi.string().uuid().required() }),
  query: Joi.object({
    kinds: Joi.alternatives(Joi.array().items(Joi.string().valid(...KINDS)), Joi.string()).optional(),
    limit: Joi.number().integer().min(1).max(100).default(30),
    cursor: Joi.string().max(300).optional(),
  }),
}), asyncHandler(async (req, res) => {
  const customer = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId }, attributes: ['id', 'email'] });
  if (!customer) throw new NotFoundError('Customer');
  let { kinds } = req.query;
  if (typeof kinds === 'string') kinds = kinds.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = (kinds || []).filter((k) => !KINDS.includes(k));
  if (bad.length) throw new ValidationError([{ field: 'kinds', message: `Unknown kinds: ${bad.join(', ')}` }]);
  res.json(await timeline(req.tenant.workspaceId, customer, { kinds, limit: req.query.limit, cursor: req.query.cursor }));
}));

module.exports = { router, timeline, KINDS };
