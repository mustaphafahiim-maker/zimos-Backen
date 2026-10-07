'use strict';

/**
 * Edge routing. A funnel edge carries an optional `condition`; when a visitor
 * finishes a step the runtime produces an `outcome` and picks the first
 * outbound edge whose condition matches, ordered by `priority` (desc) then by
 * the edge's position in the published snapshot.
 *
 * Condition grammar:
 *   { type: 'always' }              // or a null/absent condition
 *   { type: 'completed_checkout' }
 *   { type: 'accepted_offer' }      // an upsell/downsell was accepted
 *   { type: 'declined_offer' }      // an upsell/downsell was declined / skipped
 *   { type: 'clicked_through', sourceElementId? }
 *                                   // a button was pressed; with sourceElementId,
 *                                   // only that button of the page
 *
 * Any condition may also carry `when`, checked on the server against the
 * order this session placed (session.orderId) — never against anything the
 * client sends — so a path can branch on what was bought (item 376):
 *   when: {
 *     productIds?: [uuid], variantIds?: [uuid]  // the order holds any of them
 *     minTotal?: int,                           // order total ≥ (minor units)
 *     maxTotal?: int,                           // order total < (minor units)
 *     paymentMethods?: ['cod', 'card', …]       // the order was paid this way
 *   }
 * Every key given must hold. The products are the checkout order's lines,
 * with the upsells joined to it (funnelOfferMerge) and the follow-on orders
 * this funnel linked to it; the total and payment method are the checkout
 * order's. With no order yet, a `when` never matches.
 *
 * Outcome shape from the client:
 *   { type: 'completed_checkout', orderId } | { type: 'accepted_offer' }
 *   | { type: 'declined_offer' } | { type: 'clicked_through' }
 */

const CONDITION_TYPES = new Set(['always', 'completed_checkout', 'accepted_offer', 'declined_offer', 'clicked_through']);
const OUTCOME_TYPES = new Set(['completed_checkout', 'accepted_offer', 'declined_offer', 'clicked_through']);

const WHEN_KEYS = ['productIds', 'variantIds', 'minTotal', 'maxTotal', 'paymentMethods'];
const MAX_WHEN_IDS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idListProblem(list, key) {
  if (!Array.isArray(list) || list.length === 0) return `when.${key} must list at least one id`;
  if (list.length > MAX_WHEN_IDS) return `when.${key} can list at most ${MAX_WHEN_IDS} ids`;
  if (list.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) return `when.${key} must hold ids`;
  return null;
}

/** @returns {string|null} what is wrong with a condition's `when`, or null */
function whenProblem(when) {
  if (when === undefined || when === null) return null;
  if (typeof when !== 'object' || Array.isArray(when)) return 'when must be an object like { "productIds": [...] }';
  const keys = Object.keys(when);
  const unknown = keys.filter((k) => !WHEN_KEYS.includes(k));
  if (unknown.length) return `unknown when key "${unknown[0]}" (allowed: ${WHEN_KEYS.join(', ')})`;
  if (!keys.length) return 'when needs at least one of ' + WHEN_KEYS.join(', ');
  for (const key of ['productIds', 'variantIds']) {
    if (when[key] !== undefined) {
      const p = idListProblem(when[key], key);
      if (p) return p;
    }
  }
  for (const key of ['minTotal', 'maxTotal']) {
    if (when[key] !== undefined && !(Number.isSafeInteger(when[key]) && when[key] >= 0)) {
      return `when.${key} must be a whole amount in minor units (0 or more)`;
    }
  }
  if (when.minTotal !== undefined && when.maxTotal !== undefined && when.maxTotal <= when.minTotal) {
    return 'when.maxTotal must be above when.minTotal';
  }
  if (when.paymentMethods !== undefined) {
    const { ORDER_METHODS } = require('../payments/methodNames');
    if (!Array.isArray(when.paymentMethods) || when.paymentMethods.length === 0) return 'when.paymentMethods must list at least one method';
    const bad = when.paymentMethods.find((m) => !ORDER_METHODS.includes(m));
    if (bad !== undefined) return `unknown payment method "${bad}" (allowed: ${ORDER_METHODS.join(', ')})`;
  }
  return null;
}

/** @returns {string|null} an error message, or null when the condition is valid */
function conditionProblem(condition) {
  if (condition === null || condition === undefined) return null; // treated as 'always'
  if (typeof condition !== 'object' || Array.isArray(condition)) {
    return 'condition must be an object like { "type": "always" }';
  }
  if (!CONDITION_TYPES.has(condition.type)) {
    return `unknown condition type "${condition.type}" (allowed: ${[...CONDITION_TYPES].join(', ')})`;
  }
  return whenProblem(condition.when);
}

/**
 * Whether the session's order meets a `when`. ctx.order is what
 * orderContext loaded: { totalAmount, paymentMethod, productIds: Set, variantIds: Set } or null.
 */
function whenHolds(when, ctx) {
  if (!when) return true;
  const order = ctx && ctx.order;
  if (!order) return false;
  const wantsProducts = Array.isArray(when.productIds) || Array.isArray(when.variantIds);
  if (wantsProducts) {
    const hit =
      (when.productIds || []).some((id) => order.productIds.has(id)) || (when.variantIds || []).some((id) => order.variantIds.has(id));
    if (!hit) return false;
  }
  if (when.minTotal !== undefined && !(order.totalAmount >= when.minTotal)) return false;
  if (when.maxTotal !== undefined && !(order.totalAmount < when.maxTotal)) return false;
  if (Array.isArray(when.paymentMethods) && !when.paymentMethods.includes(order.paymentMethod)) return false;
  return true;
}

function matches(condition, outcome, ctx = {}) {
  const type = condition && condition.type ? condition.type : 'always';
  if (condition && condition.when && !whenHolds(condition.when, ctx)) return false;
  if (type === 'always') return true;
  if (!outcome || outcome.type !== type) return false;
  // An edge drawn from one button only follows that button's click.
  if (type === 'clicked_through' && condition.sourceElementId) {
    return outcome.sourceElementId === condition.sourceElementId;
  }
  return true;
}

/**
 * @param {Array} outboundEdges  edges whose fromStepKey === the current step, in snapshot order
 * @param {object} outcome
 * @param {object} [ctx]  { order } from orderContext, for edges with a `when`
 * @returns {object|null} the chosen edge, or null when nothing matches (funnel ends)
 */
function pickNextEdge(outboundEdges, outcome, ctx = {}) {
  const ranked = outboundEdges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => (b.edge.priority || 0) - (a.edge.priority || 0) || a.index - b.index);
  for (const { edge } of ranked) {
    if (matches(edge.condition, outcome, ctx)) return edge;
  }
  return null;
}

const hasWhen = (edges) => (edges || []).some((e) => e.condition && e.condition.when);

/**
 * What a `when` is checked against, loaded in the advance transaction: the
 * session's checkout order (session.orderId), its lines (upsells joined to it
 * included), and the lines of the follow-on orders this funnel linked to it
 * (extraOrderIds: one created in this same advance, not linked yet).
 */
async function orderContext(workspaceId, funnelId, session, { extraOrderIds = [] } = {}, transaction) {
  if (!session.orderId) return { order: null };
  const db = require('../../db/models');
  const { Op } = db.Sequelize;
  const order = await db.Order.findOne({
    where: { id: session.orderId, workspaceId },
    attributes: ['id', 'totalAmount', 'paymentMethod'],
    transaction,
  });
  if (!order) return { order: null };
  const followOns = await db.Order.findAll({
    where: { workspaceId, funnelId, linkedFromOrderId: order.id },
    attributes: ['id'],
    transaction,
  });
  const orderIds = [order.id, ...followOns.map((o) => o.id), ...extraOrderIds.filter(Boolean)];
  const items = await db.OrderItem.findAll({
    where: { orderId: { [Op.in]: [...new Set(orderIds)] } },
    attributes: ['productId', 'variantId'],
    transaction,
  });
  return {
    order: {
      totalAmount: Number(order.totalAmount),
      paymentMethod: order.paymentMethod,
      productIds: new Set(items.map((i) => i.productId).filter(Boolean)),
      variantIds: new Set(items.map((i) => i.variantId).filter(Boolean)),
    },
  };
}

/**
 * The products and variants named in edges' `when` that are not this
 * store's (deleted, or carried over from another store's funnel).
 * @returns {Promise<Array<{ field, message }>>}
 */
async function whenReferenceProblems(workspaceId, edges, { fieldOf = (i) => `edges[${i}].condition`, transaction } = {}) {
  const productIds = new Set();
  const variantIds = new Set();
  edges.forEach((e) => {
    const when = e && e.condition && e.condition.when;
    if (!when || whenProblem(when)) return;
    (when.productIds || []).forEach((id) => productIds.add(id));
    (when.variantIds || []).forEach((id) => variantIds.add(id));
  });
  if (!productIds.size && !variantIds.size) return [];
  const db = require('../../db/models');
  const [products, variants] = await Promise.all([
    productIds.size ? db.Product.findAll({ where: { workspaceId, id: [...productIds] }, attributes: ['id'], transaction }) : [],
    variantIds.size ? db.ProductVariant.findAll({ where: { workspaceId, id: [...variantIds] }, attributes: ['id'], transaction }) : [],
  ]);
  const knownProducts = new Set(products.map((p) => p.id));
  const knownVariants = new Set(variants.map((v) => v.id));
  const problems = [];
  edges.forEach((e, i) => {
    const when = e && e.condition && e.condition.when;
    if (!when || whenProblem(when)) return;
    const missingProduct = (when.productIds || []).find((id) => !knownProducts.has(id));
    const missingVariant = (when.variantIds || []).find((id) => !knownVariants.has(id));
    if (missingProduct) problems.push({ field: fieldOf(i), message: `The product ${missingProduct} in this path's condition is not in this store` });
    else if (missingVariant) problems.push({ field: fieldOf(i), message: `The variant ${missingVariant} in this path's condition is not in this store` });
  });
  return problems;
}

module.exports = {
  CONDITION_TYPES,
  OUTCOME_TYPES,
  WHEN_KEYS,
  conditionProblem,
  whenProblem,
  matches,
  pickNextEdge,
  hasWhen,
  orderContext,
  whenReferenceProblems,
};
