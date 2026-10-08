'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { zonedMidnight } = require('../../core/utils/zonedMonth');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { ORDER_REFERENCE_TYPES } = require('./orderStock');

/*
 * Stock movement history (spec-gaps item 389), read from inventory_movements.
 *
 * Mounted inside inventoryRoutes (already behind authenticate + resolveTenant),
 * before GET /:variantId, so the paths are
 *   GET /workspaces/:ws/inventory/movements
 *   GET /workspaces/:ws/inventory/:variantId/movements
 * Reading needs inventory.view, like the stock read beside it.
 *
 * Each row: when (and the store's wall-clock time), type, the change to on
 * hand and to reserved, the location it landed at, the reason, where it came
 * from (an order, a purchase order, a stock count, a return, a lot, a
 * location adjustment, a sheet bulk update, the variant table) and who did it
 * (a team member, the customer placing the order, or "system").
 *
 * Movements do not store the count after them, so none is given.
 *
 * The location is the one the source names — the location adjusted, the
 * purchase order's or stock count's or lot's location, the order's stock
 * location — and otherwise the store's default location, which is where every
 * variant-level change lands (stockLocations/index.js). An order's location
 * is the one it has now.
 */

const TYPES = ['restock', 'adjustment', 'reserve', 'release', 'commit', 'return_restock'];
const MAX_EXPORT = 10000;
const ORDER_EVENTS = {
  order_pending: 'placed',
  order_upsell: 'upsell',
  order_edited: 'edited',
  order_reconfirmed: 'reconfirmed',
  order_reopened: 'reopened',
  order_rejected: 'rejected',
  order_cancelled: 'cancelled',
  order_payment_expired: 'payment_expired',
  order_customer_blocked: 'customer_blocked',
  order_returned: 'returned',
  order_reshipped: 'reshipped',
};
// Rows written before these writers named themselves (bulk update, variant table) are told by their reason.
const LEGACY_REASONS = { 'Bulk update from a sheet': 'bulk_update', 'Variant table edit': 'variant_table' };

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

async function timezoneOf(workspaceId) {
  const w = await db.Workspace.findByPk(workspaceId, { attributes: ['timezone'] });
  let tz = (w && w.timezone) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  return tz;
}

/** `from` at the start of its day and `to` at the end of its day, on the store's clock. */
function windowOf(query, tz) {
  const at = (v, endOfDay) => {
    if (typeof v === 'string' && DAY_ONLY.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      return zonedMidnight(y, m - 1, d + (endOfDay ? 1 : 0), tz);
    }
    return new Date(v);
  };
  const from = query.from ? at(query.from, false) : null;
  const to = query.to ? at(query.to, true) : null;
  if (from && to && !(from < to)) throw new ValidationError([{ field: 'from', message: '`from` must be before `to`' }]);
  return { from, to };
}

function typesOf(type) {
  if (!type) return null;
  const list = [...new Set(String(type).split(',').map((t) => t.trim()).filter(Boolean))];
  const bad = list.filter((t) => !TYPES.includes(t));
  if (bad.length || !list.length) throw new ValidationError([{ field: 'type', message: `type must be one or more of ${TYPES.join(', ')}` }]);
  return list;
}

function parseCursor(cursor) {
  if (!cursor) return null;
  const m = CURSOR.exec(String(cursor));
  if (!m) throw new ValidationError([{ field: 'cursor', message: 'Not a cursor from this list' }]);
  return { at: m[1], id: m[2] };
}

async function query(workspaceId, f, { limit, cursor }) {
  const def = await db.StockLocation.findOne({ where: { workspaceId, isDefault: true }, attributes: ['id'] });
  const r = {
    ws: workspaceId,
    def: def ? def.id : null,
    orderTypes: ORDER_REFERENCE_TYPES,
    limit,
  };
  const inner = ['m.workspace_id = :ws'];
  if (f.variantId) { inner.push('m.variant_id = :variantId'); r.variantId = f.variantId; }
  if (f.productId) { inner.push('m.variant_id IN (SELECT pv.id FROM product_variants pv WHERE pv.product_id = :productId)'); r.productId = f.productId; }
  if (f.types) { inner.push('m.type::text IN (:types)'); r.types = f.types; }
  if (f.from) { inner.push('m.created_at >= :from'); r.from = f.from; }
  if (f.to) { inner.push('m.created_at < :to'); r.to = f.to; }
  const after = parseCursor(cursor);
  if (after) { inner.push('(m.created_at, m.id) < (CAST(:cAt AS timestamptz), CAST(:cId AS uuid))'); r.cAt = after.at; r.cId = after.id; }
  const outer = [];
  if (f.locationId) { outer.push('x.location_id = :locationId'); r.locationId = f.locationId; }

  const join = (alias, table, refType) =>
    `LEFT JOIN ${table} ${alias} ON m.reference_type ${Array.isArray(refType) ? 'IN (:orderTypes)' : `= '${refType}'`} AND ${alias}.workspace_id = m.workspace_id AND ${alias}.id::text = m.reference_id`;

  // The page of movements is picked first (index inventory_movements_workspace_created_idx, migration
  // 526) and only those rows are joined, unless the location is filtered on: it is known only after
  // the joins, so then every matching movement is joined before the page is cut (item 389 review).
  const page = outer.length ? '' : 'ORDER BY m.created_at DESC, m.id DESC LIMIT :limit';

  return db.sequelize.query(
    `WITH page AS (
       SELECT m.* FROM inventory_movements m WHERE ${inner.join(' AND ')} ${page}
     ), x AS (
       SELECT m.id, m.created_at, m.type::text AS type, m.quantity_delta, m.reserved_delta, m.reason,
              m.reference_type, m.reference_id, m.actor_user_id, m.variant_id,
              to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
              v.sku, v.option_values, v.product_id, p.name AS product_name,
              u.full_name AS actor_name,
              o.order_number, po.number AS po_number, sc.note AS count_note, sl.lot_code,
              rr.order_id AS return_order_id, ro.order_number AS return_order_number,
              COALESCE(refloc.id, po.location_id, sc.location_id, sl.location_id, o.stock_location_id, ro.stock_location_id, CAST(:def AS uuid)) AS location_id
         FROM page m
         LEFT JOIN product_variants v ON v.id = m.variant_id
         LEFT JOIN products p ON p.id = v.product_id
         LEFT JOIN users u ON u.id = m.actor_user_id
         ${join('o', 'orders', ORDER_REFERENCE_TYPES)}
         ${join('po', 'purchase_orders', 'purchase_order')}
         ${join('sc', 'stock_counts', 'stock_count')}
         ${join('sl', 'stock_lots', 'stock_lot')}
         ${join('rr', 'return_requests', 'return_restock')}
         LEFT JOIN orders ro ON ro.id = rr.order_id
         ${join('refloc', 'stock_locations', 'stock_location')}
     )
     SELECT x.*, loc.name AS location_name
       FROM x LEFT JOIN stock_locations loc ON loc.id = x.location_id
      ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT :limit`,
    { replacements: r, type: QueryTypes.SELECT }
  );
}

function sourceOf(row) {
  const t = row.reference_type || LEGACY_REASONS[row.reason] || null;
  if (t && ORDER_EVENTS[t]) return { type: 'order', id: row.reference_id, orderNumber: row.order_number || null, event: ORDER_EVENTS[t] };
  switch (t) {
    case 'purchase_order':
      return { type: 'purchase_order', id: row.reference_id, number: row.po_number || null };
    case 'stock_count':
      return { type: 'stock_count', id: row.reference_id, note: row.count_note || null };
    case 'return_restock':
      return { type: 'return', id: row.reference_id, orderId: row.return_order_id || null, orderNumber: row.return_order_number || null };
    case 'stock_lot':
      return { type: 'stock_lot', id: row.reference_id || null, lotCode: row.lot_code || null };
    case 'stock_location':
      return { type: 'location_adjustment', id: row.reference_id };
    case 'bulk_update':
      return { type: 'bulk_update', id: null };
    case 'variant_table':
      return { type: 'variant_table', id: row.reference_id || null };
    case null:
      return { type: 'manual', id: null };
    default:
      return { type: t, id: row.reference_id || null };
  }
}

function actorOf(row) {
  if (row.actor_user_id) return { type: 'user', id: row.actor_user_id, name: row.actor_name || null };
  // A storefront order reserves its stock with no team member behind it.
  if (row.reference_type === 'order_pending' || row.reference_type === 'order_upsell') return { type: 'customer', id: null, name: null };
  return { type: 'system', id: null, name: null };
}

function localTime(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return (d) => fmt.format(new Date(d)).replace(',', '');
}

function serialize(row, when) {
  const quantityDelta = Number(row.quantity_delta);
  const reservedDelta = Number(row.reserved_delta);
  return {
    id: row.id,
    at: new Date(row.created_at).toISOString(),
    localTime: when(row.created_at),
    type: row.type,
    quantityDelta,
    reservedDelta,
    availableDelta: quantityDelta - reservedDelta,
    variant: { id: row.variant_id, productId: row.product_id || null, productName: row.product_name || null, sku: row.sku || null, optionValues: row.option_values || {} },
    location: row.location_id ? { id: row.location_id, name: row.location_name || null } : null,
    reason: row.reason || null,
    source: sourceOf(row),
    actor: actorOf(row),
  };
}

async function list(workspaceId, filters, tz) {
  const limit = filters.limit;
  const rows = await query(workspaceId, filters, { limit, cursor: filters.cursor });
  const when = localTime(tz);
  const last = rows[rows.length - 1];
  return {
    movements: rows.map((row) => serialize(row, when)),
    nextCursor: rows.length === limit && last ? `${last.cursor_at}|${last.id}` : null,
    timezone: tz,
  };
}

// ------------------------------------------------------------- export --

const COLUMNS = {
  en: ['Date', 'Type', 'Product', 'SKU', 'Variant', 'On hand change', 'Reserved change', 'Location', 'Source', 'Reference', 'Reason', 'By'],
  ar: ['التاريخ', 'النوع', 'المنتج', 'SKU', 'النسخة', 'تغيّر المخزون', 'تغيّر المحجوز', 'المخزن', 'المصدر', 'المرجع', 'السبب', 'بواسطة'],
};
const WORDS = {
  en: {
    restock: 'Restock', adjustment: 'Adjustment', reserve: 'Reserved', release: 'Released', commit: 'Deducted', return_restock: 'Return restock',
    order: 'Order', purchase_order: 'Purchase order', stock_count: 'Stock count', return: 'Return', stock_lot: 'Lot',
    location_adjustment: 'Location adjustment', bulk_update: 'Bulk update from a sheet', variant_table: 'Variant table', manual: 'Manual',
    system: 'System', customer: 'Customer', deleted: 'Deleted user',
    placed: 'placed', upsell: 'upsell', edited: 'edited', reconfirmed: 'reconfirmed', reopened: 'reopened', rejected: 'rejected',
    cancelled: 'cancelled', payment_expired: 'payment expired', customer_blocked: 'customer blocked', returned: 'returned', reshipped: 'reshipped',
  },
  ar: {
    restock: 'إضافة مخزون', adjustment: 'تعديل', reserve: 'حجز', release: 'فك حجز', commit: 'خصم', return_restock: 'إرجاع للمخزون',
    order: 'طلب', purchase_order: 'أمر شراء', stock_count: 'جرد', return: 'مرتجع', stock_lot: 'دفعة',
    location_adjustment: 'تعديل مخزن', bulk_update: 'تحديث جماعي من ملف', variant_table: 'جدول النسخ', manual: 'يدوي',
    system: 'النظام', customer: 'العميل', deleted: 'مستخدم محذوف',
    placed: 'إنشاء', upsell: 'عرض إضافي', edited: 'تعديل', reconfirmed: 'إعادة تأكيد', reopened: 'إعادة فتح', rejected: 'رفض',
    cancelled: 'إلغاء', payment_expired: 'انتهاء مهلة الدفع', customer_blocked: 'حظر العميل', returned: 'مرتجع', reshipped: 'إعادة شحن',
  },
};

function exportRow(m, lang) {
  const w = (k) => (k && (WORDS[lang][k] || k)) || '';
  const s = m.source;
  let source = w(s.type);
  if (s.type === 'order' && s.event) source = `${source} (${w(s.event)})`;
  const reference =
    s.orderNumber || s.number || s.lotCode || (s.type === 'location_adjustment' && m.location ? m.location.name : '') || (s.type === 'stock_count' ? s.note || s.id : '') || '';
  const variant = Object.values(m.variant.optionValues || {}).join(' / ');
  const by = m.actor.type === 'user' ? m.actor.name || w('deleted') : w(m.actor.type);
  return [m.localTime, w(m.type), m.variant.productName || '', m.variant.sku || '', variant, m.quantityDelta, m.reservedDelta, m.location ? m.location.name || '' : '', source, reference, m.reason || '', by];
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  // A cell a spreadsheet would run as a formula is kept as text.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ------------------------------------------------------------- routes --

const uuid = Joi.string().uuid();
const when = Joi.alternatives().try(Joi.string().pattern(DAY_ONLY), Joi.date().iso());
const listQuery = {
  type: Joi.string().max(200),
  from: when,
  to: when,
  locationId: uuid,
  limit: Joi.number().integer().min(1).max(200).default(50),
  cursor: Joi.string().max(100),
  format: Joi.string().valid('json', 'csv', 'xlsx').default('json'),
  lang: Joi.string().valid('en', 'ar').default('en'),
};

async function answer(req, res, extra = {}) {
  const { workspaceId } = req.tenant;
  const { format, lang, cursor, limit, ...q } = req.query;
  const tz = await timezoneOf(workspaceId);
  const { from, to } = windowOf(q, tz);
  const filters = { variantId: q.variantId, productId: q.productId, locationId: q.locationId, types: typesOf(q.type), from, to };
  if (format === 'json') return res.json({ ...extra, ...(await list(workspaceId, { ...filters, limit, cursor }, tz)) });

  const page = await list(workspaceId, { ...filters, limit: MAX_EXPORT }, tz);
  const table = [COLUMNS[lang], ...page.movements.map((m) => exportRow(m, lang))];
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'inventory_movements.export',
    entityType: 'InventoryMovement',
    metadata: { format, rows: table.length - 1, filters: { variantId: q.variantId, productId: q.productId, locationId: q.locationId, type: q.type, from: q.from, to: q.to } },
    req,
  });
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'xlsx') {
    const file = require('../orders/xlsxWriter').buildXlsx(table, { sheetName: lang === 'ar' ? 'حركة المخزون' : 'Stock movements', rtl: lang === 'ar' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="stock-movements-${day}.xlsx"`);
    return res.send(file);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stock-movements-${day}.csv"`);
  return res.send(`﻿${table.map((row) => row.map(csvCell).join(',')).join('\n')}`);
}

const router = Router({ mergeParams: true });
const canView = requirePermission(PERMISSIONS.INVENTORY_VIEW);

router.get(
  '/movements',
  canView,
  validate({ params: Joi.object({ workspaceId: uuid.required() }), query: Joi.object({ ...listQuery, variantId: uuid, productId: uuid }) }),
  asyncHandler((req, res) => answer(req, res))
);

router.get(
  '/:variantId/movements',
  canView,
  validate({ params: Joi.object({ workspaceId: uuid.required(), variantId: uuid.required() }), query: Joi.object(listQuery) }),
  asyncHandler(async (req, res) => {
    const variant = await db.ProductVariant.findOne({ where: { id: req.params.variantId, workspaceId: req.tenant.workspaceId }, attributes: ['id', 'stockOnHand', 'reservedStock'] });
    if (!variant) throw new NotFoundError('ProductVariant');
    req.query.variantId = variant.id;
    const stock = { stockOnHand: Number(variant.stockOnHand), reservedStock: Number(variant.reservedStock), availableStock: Number(variant.stockOnHand) - Number(variant.reservedStock) };
    return answer(req, res, { variantId: variant.id, stock });
  })
);

module.exports = { router, list, TYPES };
