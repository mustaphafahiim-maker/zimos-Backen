'use strict';

const { Router } = require('express');
const { QueryTypes } = require('sequelize');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const schemas = require('./orderValidation');
const orderTimeline = require('./orderTimeline');

/**
 * GET /workspaces/:ws/orders/:orderId/session-details — what the order page
 * shows beyond the order itself (SPEC §4.4):
 *
 *   - session details: the pages the shopper viewed before ordering (the last
 *     MAX_PAGES, oldest first), how many in all, the first visit and the time
 *     from it to the order;
 *   - the order's place in the customer's history: its sequence number
 *     ("first order"), how many orders the customer has, the first one;
 *   - the last action on the order and its time (the newest timeline entry),
 *     for the page header.
 *
 * The shopper is found through the store's own analytics: the visitor whose
 * purchase event carried this order, else the visitor id the checkout sent
 * (orders.ad_match). An order with neither (manual, a blocked tracker) has no
 * pages. Nothing here is personal beyond what the order page already shows.
 */

const MAX_PAGES = 30;
const PAGE_VIEW = 1;

async function visitorOf(order) {
  const [row] = await db.sequelize.query(
    `SELECT visitor_id FROM analytics_events
      WHERE workspace_id = :workspaceId AND order_id = :orderId
      ORDER BY created_at ASC LIMIT 1`,
    { replacements: { workspaceId: order.workspaceId, orderId: order.id }, type: QueryTypes.SELECT }
  );
  if (row && row.visitor_id) return row.visitor_id;
  return (order.adMatch && order.adMatch.visitorId) || null;
}

async function pagesOf(order, visitorId) {
  if (!visitorId) return { pages: [], pageViews: 0, firstVisitAt: null };
  // A minute past the order: the thank-you page and the order's own events land just after it.
  const until = new Date(new Date(order.createdAt).getTime() + 60 * 1000);
  const replacements = { workspaceId: order.workspaceId, visitorId, until, type: PAGE_VIEW, limit: MAX_PAGES };
  const [rows, [summary]] = await Promise.all([
    db.sequelize.query(
      `SELECT url_path AS path, page_title AS title, created_at AS at
         FROM analytics_events
        WHERE workspace_id = :workspaceId AND visitor_id = :visitorId AND event_type = :type AND created_at <= :until
        ORDER BY created_at DESC
        LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT COUNT(*) FILTER (WHERE event_type = :type) AS "pageViews", MIN(created_at) AS "firstVisitAt"
         FROM analytics_events
        WHERE workspace_id = :workspaceId AND visitor_id = :visitorId AND created_at <= :until`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);
  return {
    pages: rows.reverse().map((r) => ({ path: r.path || '/', title: r.title || null, at: new Date(r.at).toISOString() })),
    pageViews: Number(summary && summary.pageViews) || 0,
    firstVisitAt: summary && summary.firstVisitAt ? new Date(summary.firstVisitAt).toISOString() : null,
  };
}

async function customerHistory(order) {
  if (!order.customerId) return null;
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at < :at OR (created_at = :at AND id <= :orderId)) AS sequence,
            MIN(created_at) AS "firstOrderAt"
       FROM orders
      WHERE workspace_id = :workspaceId AND customer_id = :customerId AND is_test = false`,
    {
      replacements: { workspaceId: order.workspaceId, customerId: order.customerId, at: order.createdAt, orderId: order.id },
      type: QueryTypes.SELECT,
    }
  );
  const total = Number(row && row.total) || 0;
  // A test order is not counted among the customer's orders; it is still "this" order.
  const sequence = order.isTest ? null : Number(row && row.sequence) || null;
  return {
    orderSequence: sequence,
    totalOrders: total,
    isNewCustomer: !order.isTest && total === 1,
    firstOrderAt: row && row.firstOrderAt ? new Date(row.firstOrderAt).toISOString() : null,
  };
}

async function sessionDetails(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    attributes: ['id', 'workspaceId', 'customerId', 'createdAt', 'isTest', 'sessionStats', 'adMatch'],
  });
  if (!order) throw new NotFoundError('Order');
  const visitorId = await visitorOf(order);
  const [visits, customer, events] = await Promise.all([
    pagesOf(order, visitorId),
    customerHistory(order),
    orderTimeline.timeline(workspaceId, orderId),
  ]);
  const stats = order.sessionStats || {};
  const firstVisitAt = stats.firstVisitAt || visits.firstVisitAt;
  const timeToPurchaseSeconds = firstVisitAt
    ? Math.max(0, Math.round((new Date(order.createdAt).getTime() - new Date(firstVisitAt).getTime()) / 1000))
    : null;
  return {
    tracked: Boolean(visitorId),
    pages: visits.pages,
    pageViews: Math.max(visits.pageViews, Number(stats.pageViews) || 0),
    firstVisitAt: firstVisitAt || null,
    timeToPurchaseSeconds,
    customer,
    lastAction: events[0] || null,
  };
}

const router = Router({ mergeParams: true });
router.get(
  '/:orderId/session-details',
  validate(schemas.get),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  asyncHandler(async (req, res) => res.json(await sessionDetails(req.tenant.workspaceId, req.params.orderId)))
);

module.exports = { router, sessionDetails };
