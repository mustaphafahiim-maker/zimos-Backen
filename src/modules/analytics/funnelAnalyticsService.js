'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { resolveRange, dayKey, rate, toNumber, DAY_MS } = require('./analyticsService');
const base = require('../currencies/baseAmounts');

const SESSION_ATTRIBUTES = ['id', 'funnelId', 'currentStepKey', 'path', 'orderId', 'attribution', 'status', 'createdAt'];
const ORDER_ATTRIBUTES = ['id', 'funnelId', 'linkedFromOrderId', ...base.ATTRIBUTES, 'cancelledAt', 'confirmationState', 'createdAt'];
const FUNNEL_ATTRIBUTES = ['id', 'name', 'subdomain', 'status', 'publishedRevisionId'];

/** Same "active" rule getSummary uses for gross revenue. */
const isActiveOrder = (o) => !o.cancelledAt && o.confirmationState !== 'rejected';

async function loadWorkspace(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  return {
    timeZone: (workspace && workspace.timezone) || 'UTC',
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
  };
}

function emptyMetrics() {
  return { sessions: 0, completed: 0, orders: 0, revenue: 0, upsellOrders: 0, upsellRevenue: 0 };
}

function addSession(m, s) {
  m.sessions += 1;
  if (s.orderId) m.completed += 1;
}

/** Only active orders are counted; cancelled/rejected orders are ignored entirely. */
function addOrder(m, o) {
  if (!isActiveOrder(o)) return;
  // In the store's base currency: funnels may sell in other currencies.
  const total = base.total(o);
  m.orders += 1;
  m.revenue += total;
  if (o.linkedFromOrderId) {
    m.upsellOrders += 1;
    m.upsellRevenue += total;
  }
  // Offers joined to the checkout order (funnels/funnelOfferMerge.js) are its
  // is_upsell lines: counted as accepted offers, their amount as upsell revenue.
  if (o.mergedUpsells) {
    m.upsellOrders += o.mergedUpsells.count;
    m.upsellRevenue += o.mergedUpsells.amount;
  }
}

/** Tags each order with its is_upsell lines (count and amount). */
async function withMergedUpsells(orders) {
  if (orders.length === 0) return orders;
  const lines = await db.OrderItem.findAll({
    where: { orderId: orders.map((o) => o.id), isUpsell: true },
    attributes: ['orderId', 'lineTotalAmount'],
  });
  const byOrder = new Map();
  for (const line of lines) {
    const entry = byOrder.get(line.orderId) || { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += toNumber(line.lineTotalAmount);
    byOrder.set(line.orderId, entry);
  }
  for (const o of orders) {
    const entry = byOrder.get(o.id);
    o.mergedUpsells = entry ? { count: entry.count, amount: base.amount(o, entry.amount) } : null;
  }
  return orders;
}

const withRate = (m) => ({ ...m, conversionRate: rate(m.completed, m.sessions) });

/**
 * Per-funnel performance for a date range, computed from stored funnel
 * sessions and orders only.
 *
 * - sessions: FunnelSession rows created in range (`to` exclusive).
 * - completed: those sessions with an orderId (a checkout finished inside the funnel).
 * - conversionRate: completed / sessions as a percentage, null when there are no sessions.
 * - orders / revenue: orders with funnel_id = funnel created in range, excluding
 *   cancelled and rejected orders (the same "active" rule as getSummary).
 *   revenue is the sum of totalAmount in integer minor units.
 * - upsellOrders / upsellRevenue: the subset of those orders that were created by
 *   accepting an upsell/downsell offer (linkedFromOrderId set).
 * - Every funnel in the workspace is listed, even with zero activity, sorted by
 *   revenue then sessions descending.
 */
async function getFunnelsOverview(workspaceId, query = {}) {
  const { start, end } = resolveRange(query);
  const { timeZone, currency } = await loadWorkspace(workspaceId);
  const createdAt = { [Op.gte]: start, [Op.lt]: end };

  const [funnels, sessions, orders] = await Promise.all([
    db.Funnel.findAll({ where: { workspaceId }, attributes: FUNNEL_ATTRIBUTES, order: [['createdAt', 'ASC']] }),
    db.FunnelSession.findAll({ where: { workspaceId, createdAt }, attributes: SESSION_ATTRIBUTES }),
    db.Order.findAll({ where: { workspaceId, funnelId: { [Op.ne]: null }, createdAt }, attributes: ORDER_ATTRIBUTES }).then(
      withMergedUpsells
    ),
  ]);

  const byFunnel = new Map(funnels.map((f) => [f.id, emptyMetrics()]));
  const totals = emptyMetrics();
  for (const s of sessions) {
    const m = byFunnel.get(s.funnelId);
    if (!m) continue; // session for a deleted funnel — not attributable
    addSession(m, s);
    addSession(totals, s);
  }
  for (const o of orders) {
    const m = byFunnel.get(o.funnelId);
    if (!m) continue;
    addOrder(m, o);
    addOrder(totals, o);
  }

  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone },
    currency,
    totals: withRate(totals),
    funnels: funnels
      .map((f) => ({ id: f.id, name: f.name, subdomain: f.subdomain, status: f.status, ...withRate(byFunnel.get(f.id)) }))
      .sort((a, b) => b.revenue - a.revenue || b.sessions - a.sessions),
  };
}

/**
 * Steps in visitor order: breadth-first walk of the edges from `entryKey`,
 * deduplicated, with any step not reachable from the entry appended in its
 * original order so nothing is silently hidden.
 */
function orderSteps(steps, edges, entryKey) {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const ordered = [];
  const seen = new Set();
  const queue = entryKey && byKey.has(entryKey) ? [entryKey] : [];
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(byKey.get(key));
    for (const e of edges) {
      if (e.fromStepKey === key && byKey.has(e.toStepKey) && !seen.has(e.toStepKey)) queue.push(e.toStepKey);
    }
  }
  for (const s of steps) if (!seen.has(s.key)) ordered.push(s);
  return ordered;
}

/** Published snapshot when there is one, otherwise the draft step rows (same order listSteps uses). */
async function loadStepGraph(funnel) {
  if (funnel.publishedRevisionId) {
    const revision = await db.FunnelRevision.findOne({
      where: { id: funnel.publishedRevisionId, funnelId: funnel.id },
      attributes: ['snapshot'],
    });
    const snapshot = (revision && revision.snapshot) || {};
    return { steps: snapshot.steps || [], edges: snapshot.edges || [], entryKey: snapshot.entryKey || null };
  }
  const rows = await db.FunnelStep.findAll({
    where: { workspaceId: funnel.workspaceId, funnelId: funnel.id },
    attributes: ['key', 'name', 'stepType'],
    order: [['createdAt', 'ASC']],
  });
  return { steps: rows.map((s) => ({ key: s.key, name: s.name, stepType: s.stepType })), edges: [], entryKey: null };
}

const attr = (a, ...keys) => {
  for (const k of keys) {
    if (a && typeof a[k] === 'string' && a[k]) return a[k];
  }
  return null;
};

/**
 * Detail for one funnel: the overview metrics plus
 *
 * - steps (in funnel order): reached = sessions whose `path` contains the step
 *   or that are currently on it; dropped = sessions sitting on the step that
 *   never moved on (currentStepKey === key and status !== 'completed');
 *   reachRate = reached / sessions percentage (null with no sessions).
 * - sources: sessions grouped by attribution (utm_source ?? source ?? 'direct',
 *   utm_medium ?? medium, utm_campaign ?? campaign). Orders/revenue per source
 *   are the active orders completed inside those sessions plus the upsell
 *   orders linked from them. Top 10 by sessions.
 * - series: one entry per day (workspace timezone): sessions started, active
 *   funnel orders created, and their revenue.
 */
async function getFunnelDetail(workspaceId, funnelId, query = {}) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: [...FUNNEL_ATTRIBUTES, 'workspaceId'] });
  if (!funnel) throw new NotFoundError('Funnel');

  const { start, end } = resolveRange(query);
  const { timeZone, currency } = await loadWorkspace(workspaceId);
  const createdAt = { [Op.gte]: start, [Op.lt]: end };

  const [graph, sessions, orders] = await Promise.all([
    loadStepGraph(funnel),
    db.FunnelSession.findAll({ where: { workspaceId, funnelId, createdAt }, attributes: SESSION_ATTRIBUTES, order: [['createdAt', 'ASC']] }),
    db.Order.findAll({ where: { workspaceId, funnelId, createdAt }, attributes: ORDER_ATTRIBUTES, order: [['createdAt', 'ASC']] }).then(
      withMergedUpsells
    ),
  ]);

  const totals = emptyMetrics();
  const series = new Map();
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const key = dayKey(new Date(t), timeZone);
    series.set(key, { date: key, sessions: 0, orders: 0, revenue: 0 });
  }
  const dayOf = (date) => {
    const key = dayKey(date, timeZone);
    if (!series.has(key)) series.set(key, { date: key, sessions: 0, orders: 0, revenue: 0 });
    return series.get(key);
  };

  // Sources: group sessions, remembering which checkout orders belong to each group.
  const sources = new Map();
  const orderToSource = new Map();
  for (const s of sessions) {
    addSession(totals, s);
    dayOf(s.createdAt).sessions += 1;

    const a = s.attribution || {};
    const source = attr(a, 'utm_source', 'source') || 'direct';
    const medium = attr(a, 'utm_medium', 'medium');
    const campaign = attr(a, 'utm_campaign', 'campaign');
    const groupKey = JSON.stringify([source, medium, campaign]);
    const g = sources.get(groupKey) || { source, medium, campaign, sessions: 0, completed: 0, orders: 0, revenue: 0 };
    g.sessions += 1;
    if (s.orderId) {
      g.completed += 1;
      orderToSource.set(s.orderId, g);
    }
    sources.set(groupKey, g);
  }

  for (const o of orders) {
    addOrder(totals, o);
    if (!isActiveOrder(o)) continue;
    const day = dayOf(o.createdAt);
    day.orders += 1;
    day.revenue += base.total(o);
    const g = orderToSource.get(o.id) || (o.linkedFromOrderId && orderToSource.get(o.linkedFromOrderId));
    if (g) {
      g.orders += 1;
      g.revenue += base.total(o);
    }
  }

  // Page performance per step (funnelStepMetrics.js).
  const ordered = orderSteps(graph.steps, graph.edges, graph.entryKey);
  const perStep = await require('./funnelStepMetrics').stepMetrics(workspaceId, funnel.id, ordered, sessions, { start, end });
  const steps = ordered.map((step) => {
    let reached = 0;
    let dropped = 0;
    for (const s of sessions) {
      const onStep = s.currentStepKey === step.key;
      if (onStep || (s.path || []).includes(step.key)) reached += 1;
      if (onStep && s.status !== 'completed') dropped += 1;
    }
    return { key: step.key, name: step.name, stepType: step.stepType, reached, dropped, reachRate: rate(reached, totals.sessions), ...perStep.get(step.key) };
  });

  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone },
    currency,
    funnel: { id: funnel.id, name: funnel.name, subdomain: funnel.subdomain, status: funnel.status },
    ...withRate(totals),
    // Earnings per click: revenue ÷ visitors (sessions), minor units of the base currency.
    epc: totals.sessions > 0 ? Math.round(totals.revenue / totals.sessions) : null,
    steps,
    sources: Array.from(sources.values()).sort((a, b) => b.sessions - a.sessions || b.revenue - a.revenue).slice(0, 10),
    series: Array.from(series.values()),
  };
}

module.exports = { getFunnelsOverview, getFunnelDetail };
