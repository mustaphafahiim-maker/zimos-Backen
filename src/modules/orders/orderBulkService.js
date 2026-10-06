'use strict';

const db = require('../../db/models');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const orderService = require('./orderService');
const orderMeta = require('./orderMetaService');
const stageChange = require('./orderStageChange');

/**
 * POST /orders/bulk — one action over many orders (SPEC §4.3 bulk actions).
 *
 * Each order is handled on its own, exactly as its single-order endpoint
 * would handle it — same guards, same audit rows, its own transaction — so
 * one order that cannot take the action never blocks the rest. The answer
 * says what happened to every order, and the screen shows the failures.
 *
 * The orders are either named (`orderIds`) or "everything this filter shows"
 * (`filter`, the orders list's own query), capped at MAX_ORDERS either way.
 */
const MAX_ORDERS = 500;

const ACTIONS = {
  set_status: (workspaceId, id, payload, req) =>
    stageChange.changeStage(
      workspaceId,
      id,
      { status: payload.status, reason: payload.reason, followUp: payload.followUp, carrierCode: payload.carrierCode, notifyCustomer: payload.notifyCustomer },
      req
    ),
  add_tag: (workspaceId, id, payload, req) => orderMeta.updateMeta(workspaceId, id, { addTags: payload.tags }, req),
  remove_tag: (workspaceId, id, payload, req) => orderMeta.updateMeta(workspaceId, id, { removeTags: payload.tags }, req),
  archive: (workspaceId, id, payload, req) => orderMeta.updateMeta(workspaceId, id, { archived: true }, req),
  unarchive: (workspaceId, id, payload, req) => orderMeta.updateMeta(workspaceId, id, { archived: false }, req),
  mark_seen: (workspaceId, id, payload, req) => orderMeta.updateMeta(workspaceId, id, { isSeen: true }, req),
  mark_unseen: (workspaceId, id, payload, req) => orderMeta.updateMeta(workspaceId, id, { isSeen: false }, req),
  // Books each order with a connected courier, or records a manual shipment
  // under the name given — whichever orderService.createShipment decides.
  ship: (workspaceId, id, payload, req) =>
    orderService.createShipment(workspaceId, id, { carrierCode: payload.carrierCode, notes: payload.notes }, req),
};

const ACTION_KEYS = Object.keys(ACTIONS);

function assertPayload(action, payload) {
  const missing = (field) => new ValidationError([{ field: `payload.${field}`, message: `"${field}" is required for ${action}` }]);
  if (action === 'set_status' && !payload.status) throw missing('status');
  if ((action === 'add_tag' || action === 'remove_tag') && !(payload.tags && payload.tags.length)) throw missing('tags');
  if (action === 'ship' && !payload.carrierCode) throw missing('carrierCode');
}

/** Ids of every order the list would show for `filter`, in list order, up to MAX_ORDERS. */
async function idsForFilter(workspaceId, filter) {
  const ids = [];
  let cursor;
  do {
    const page = await orderService.listOrders(workspaceId, { ...filter, limit: 200, cursor });
    for (const order of page.orders) ids.push(order.id);
    cursor = page.nextCursor;
  } while (cursor && ids.length < MAX_ORDERS);
  return ids.slice(0, MAX_ORDERS);
}

async function bulk(workspaceId, { action, orderIds, filter, payload = {} }, req) {
  assertPayload(action, payload);
  const ids = orderIds && orderIds.length ? [...new Set(orderIds)] : await idsForFilter(workspaceId, filter || {});
  if (ids.length === 0) throw new AppError('NO_ORDERS_SELECTED', 'No orders match this selection', 422);

  const orders = await db.Order.findAll({ where: { workspaceId, id: ids }, attributes: ['id', 'orderNumber'] });
  const numbers = new Map(orders.map((o) => [o.id, o.orderNumber]));

  const results = [];
  for (const id of ids) {
    if (!numbers.has(id)) {
      results.push({ orderId: id, orderNumber: null, ok: false, code: 'NOT_FOUND', message: 'Order not found' });
      continue;
    }
    try {
      await ACTIONS[action](workspaceId, id, payload, req);
      results.push({ orderId: id, orderNumber: numbers.get(id), ok: true });
    } catch (err) {
      if (!err.isOperational) {
        logger.error('Bulk order action failed unexpectedly', { workspaceId, orderId: id, action, message: err.message });
      }
      results.push({
        orderId: id,
        orderNumber: numbers.get(id),
        ok: false,
        code: err.isOperational ? err.code : 'INTERNAL_SERVER_ERROR',
        message: err.isOperational ? err.message : 'Something went wrong with this order',
      });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return { action, total: results.length, succeeded, failed: results.length - succeeded, results };
}

module.exports = { ACTION_KEYS, MAX_ORDERS, bulk, idsForFilter };
