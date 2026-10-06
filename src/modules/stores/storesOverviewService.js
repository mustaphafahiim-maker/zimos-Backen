'use strict';

const db = require('../../db/models');
const { QueryTypes } = require('sequelize');
const logger = require('../../core/utils/logger');
const { PERMISSIONS } = require('../../core/security/permissions');
const { countsAsSaleSql } = require('../orders/orderStage');
const { accessFor } = require('../workspaces/workspaceAccessService');
const settlementStatements = require('../settlements/settlementStatementService');

/**
 * "All my stores" (SPEC §18.5): one row per store the signed-in user is an
 * active member of, with today's numbers and what needs attention.
 *
 * A workspace is one store, so this is the only place that reads across
 * workspaces for a merchant — and it only ever reads the workspaces of the
 * caller's own memberships. Numbers follow the member's role: no orders.view,
 * no order figures; no financial_reports.view, no money held by couriers.
 */

const can = (permissions, permission) => permissions.includes('*') || permissions.includes(permission);

async function orderFigures(workspaceIds) {
  if (workspaceIds.length === 0) return new Map();
  const sale = countsAsSaleSql('o');
  // "Today" is each store's own day, in its own timezone.
  const today = `(o.created_at AT TIME ZONE w.timezone)::date = (NOW() AT TIME ZONE w.timezone)::date`;
  const rows = await db.sequelize.query(
    `SELECT o.workspace_id,
            (COUNT(*) FILTER (WHERE ${today}))::int AS orders_today,
            COALESCE(SUM(o.total_amount) FILTER (WHERE ${today} AND ${sale} AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'), 0) AS sales_today,
            (COUNT(*) FILTER (WHERE o.payment_method = 'cod' AND o.confirmation_state = 'confirmed' AND o.created_at >= NOW() - INTERVAL '30 days'))::int AS confirmed_30d,
            (COUNT(*) FILTER (WHERE o.payment_method = 'cod' AND o.confirmation_state IN ('confirmed', 'rejected') AND o.created_at >= NOW() - INTERVAL '30 days'))::int AS decided_30d,
            (COUNT(*) FILTER (WHERE o.payment_method = 'cod' AND o.confirmation_state = 'pending' AND o.cancelled_at IS NULL))::int AS pending_confirmation
       FROM orders o
       JOIN workspaces w ON w.id = o.workspace_id
      WHERE o.workspace_id IN (:workspaceIds)
      GROUP BY o.workspace_id`,
    { replacements: { workspaceIds }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.workspace_id, r]));
}

async function lowStockCounts(workspaceIds) {
  if (workspaceIds.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT v.workspace_id, COUNT(*)::int AS count
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.workspace_id IN (:workspaceIds)
        AND v.low_stock_threshold IS NOT NULL
        AND v.status = 'active' AND p.status = 'active' AND p.track_inventory
        AND (v.stock_on_hand - v.reserved_stock) <= v.low_stock_threshold
      GROUP BY v.workspace_id`,
    { replacements: { workspaceIds }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.workspace_id, r.count]));
}

async function heldAmount(workspaceId) {
  try {
    const held = await settlementStatements.held(workspaceId);
    return { amount: String(held.totalAmount || 0), orders: held.totalOrders || 0 };
  } catch (err) {
    logger.error(`[stores] held money for ${workspaceId} failed: ${err.message}`);
    return null;
  }
}

async function overview(userId) {
  const memberships = await db.Membership.findAll({
    where: { userId, status: 'active' },
    include: [
      { model: db.Workspace, as: 'workspace', where: { status: ['active', 'suspended'] } },
      { model: db.Role, as: 'role' },
    ],
    order: [[{ model: db.Workspace, as: 'workspace' }, 'createdAt', 'ASC']],
  });

  const permissionsOf = (m) => (m.role && m.role.permissions) || [];
  const withOrders = memberships.filter((m) => can(permissionsOf(m), PERMISSIONS.ORDERS_VIEW)).map((m) => m.workspaceId);
  const withStock = memberships.filter((m) => can(permissionsOf(m), PERMISSIONS.INVENTORY_VIEW)).map((m) => m.workspaceId);
  const [figures, lowStock] = await Promise.all([orderFigures(withOrders), lowStockCounts(withStock)]);

  const stores = [];
  for (const m of memberships) {
    const ws = m.workspace;
    const permissions = permissionsOf(m);
    const seesOrders = can(permissions, PERMISSIONS.ORDERS_VIEW);
    const seesMoney = can(permissions, PERMISSIONS.FINANCIAL_REPORTS_VIEW);
    const f = figures.get(ws.id);
    const access = await accessFor(ws.id, { workspace: ws });
    const held = seesMoney ? await heldAmount(ws.id) : null;

    const alerts = [];
    if (access.suspension.suspended) alerts.push({ code: 'suspended' });
    else if (access.restricted) alerts.push({ code: 'billing_restricted' });
    if (access.draft) alerts.push({ code: 'draft' });
    if (seesOrders && f && f.pending_confirmation > 0) alerts.push({ code: 'pending_confirmation', count: f.pending_confirmation });
    if (lowStock.get(ws.id)) alerts.push({ code: 'low_stock', count: lowStock.get(ws.id) });

    stores.push({
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      logoUrl: ws.logoUrl,
      currency: ws.defaultCurrency,
      status: ws.status,
      draft: Boolean(access.draft),
      role: { key: m.role.key, name: m.role.name },
      isOwner: ws.ownerUserId === userId,
      // null = this member's role does not show it.
      ordersToday: seesOrders ? (f ? f.orders_today : 0) : null,
      salesToday: seesOrders ? String(f ? f.sales_today : 0) : null,
      confirmationRate: seesOrders ? (f && f.decided_30d > 0 ? Math.round((100 * f.confirmed_30d) / f.decided_30d) : null) : null,
      heldByCouriers: held,
      alerts,
    });
  }
  return { stores };
}

module.exports = { overview };
