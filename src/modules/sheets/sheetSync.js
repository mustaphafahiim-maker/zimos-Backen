'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const { toDisplay } = require('../../core/utils/money');
const { getSheetsAdapter } = require('./adapters');
const appGate = require('../apps/appGate');
const leads = require('./leadRows');

/**
 * Google Sheets sync, the writing side (SPEC §16.4: "new order = new row,
 * status change = update the status column in the same row … with retries
 * and an alert if the permission is revoked").
 *
 * - A new order (order.created) is a new row in every active orders sheet whose
 *   filter takes it; a lost order (checkout.abandoned, lost_order.created) in
 *   every lost-orders sheet; a sign-up (contact_form.submitted) in every leads
 *   sheet (leadRows.js). Where it was written is kept in sheet_row_refs.
 * - A later change (confirmed, shipped, delivered, cancelled, paid, recovered…)
 *   rewrites the same row(s) with the order as it is now — every column, so the
 *   status, the waybill and the amounts stay true. Something never written
 *   (from before the sheet was connected) is left to "Sync existing".
 * - A failure the next try may fix throws, so the outbox retries the event; a
 *   sheet whose access was taken away, or that was deleted, stops (status
 *   `revoked` / `error`) and the store is told once, by the bell and email.
 * - One row per order, or one per product line (the "group products into one
 *   row" switch). An order that later has more lines than rows keeps its rows.
 */

const ORDER_UPDATE_EVENTS = [
  'order.confirmed',
  'order.unreachable',
  'order.cancelled',
  'order.uncancelled',
  'order.shipped',
  'order.out_for_delivery',
  'order.delivered',
  'order.returned',
  'order.paid',
  'order.refunded',
  'order.updated',
  'order.item_added',
  'shipment.status_changed',
];
const LOST_NEW_EVENTS = ['checkout.abandoned', 'lost_order.created'];
const BACKFILL_DAYS = 30;
const BACKFILL_MAX = 2000;
const BATCH = 100;
// What sheet_row_refs.entity_type calls the thing each kind of sheet carries.
const ENTITY = { orders: 'order', lost_orders: 'lost_order', leads: 'lead' };

// ------------------------------------------------------------ lost orders --

const LOST_STATUS = {
  in_progress: ['In progress', 'لسه بيكمل'],
  abandoned: ['Lost', 'مفقود'],
  converted: ['Recovered', 'اترجع'],
};

/** The columns a lost-orders sheet can have, in their default order. */
const LOST_COLUMNS = [
  { key: 'date', en: 'Date', ar: 'التاريخ', value: (s, x) => x.date(s.lastActivityAt) },
  { key: 'status', en: 'Status', ar: 'الحالة', value: (s, x) => x.label(LOST_STATUS, s.convertedOrder ? 'converted' : s.status === 'in_progress' ? 'in_progress' : 'abandoned') },
  { key: 'reason', en: 'Reason', ar: 'السبب', value: (s) => s.lostReason || '' },
  { key: 'customerName', en: 'Name', ar: 'الاسم', value: (s) => s.customerName || '' },
  { key: 'phone', en: 'Phone', ar: 'الموبايل', value: (s) => s.phone || '' },
  { key: 'email', en: 'Email', ar: 'البريد', value: (s) => s.email || '' },
  { key: 'region', en: 'Governorate', ar: 'المحافظة', value: (s) => (s.shippingAddress || {}).region || (s.shippingAddress || {}).governorate || '' },
  { key: 'city', en: 'City', ar: 'المدينة', value: (s) => (s.shippingAddress || {}).city || '' },
  { key: 'address', en: 'Address', ar: 'العنوان', value: (s) => (s.shippingAddress || {}).addressLine || '' },
  { key: 'items', en: 'Products', ar: 'المنتجات', value: (s) => (s.items || []).map((i) => `${i.quantity} x ${i.productName}`).join(' | ') },
  { key: 'total', en: 'Total', ar: 'الإجمالي', numeric: true, value: (s) => toDisplay(String(s.subtotalAmount || 0)) },
  { key: 'currency', en: 'Currency', ar: 'العملة', value: (s) => s.currency || '' },
  { key: 'recovery', en: 'Follow-up', ar: 'المتابعة', value: (s) => s.recoveryStatus || '' },
  { key: 'order', en: 'Order', ar: 'الطلب', value: (s) => (s.convertedOrder ? s.convertedOrder.orderNumber : '') },
  { key: 'source', en: 'Traffic source', ar: 'مصدر الزيارة', value: (s) => (s.trafficSource ? s.trafficSource.source : '') || '' },
  { key: 'campaign', en: 'Campaign', ar: 'الحملة', value: (s) => (s.trafficSource ? s.trafficSource.campaign : '') || '' },
];
const LOST_KEYS = LOST_COLUMNS.map((c) => c.key);
const lostByKey = new Map(LOST_COLUMNS.map((c) => [c.key, c]));

function context(lang, timezone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return {
    date: (value) => (value ? format.format(new Date(value)).replace(',', '') : ''),
    label: (map, code) => (map[code] ? map[code][lang === 'ar' ? 1 : 0] : code || ''),
  };
}

function lostRow(session, connection, { lang, timezone, maskPhones }) {
  const x = context(lang, timezone);
  const shaped = maskPhones ? { ...session, phone: require('../../core/utils/phoneMask').maskPhone(session.phone) } : session;
  return connection.columns.map((entry) => {
    if (!entry.key) return entry.fixed || '';
    const column = lostByKey.get(entry.key);
    if (!column) return '';
    const value = column.value(shaped, x);
    return column.numeric && /^-?\d+(\.\d+)?$/.test(String(value)) ? Number(value) : value === null || value === undefined ? '' : String(value);
  });
}

// ---------------------------------------------------------------- shared --

async function credentialsFor(workspaceId) {
  const integration = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: 'google_sheets', status: 'connected' } });
  if (!integration || !integration.secretsSealed) return null;
  try {
    return JSON.parse(secretBox.open(integration.secretsSealed));
  } catch {
    return null;
  }
}

const headerOf = (connection) => connection.columns.map((c) => c.header);

async function settingsOf(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'timezone'] });
  return { timezone: (workspace && workspace.timezone) || 'UTC' };
}

/** The store hears about a sheet that stopped, in each teammate's language. */
async function alert(connection, reason) {
  const notifications = require('../notifications/merchantNotificationService');
  const name = connection.name;
  const text =
    reason === 'revoked'
      ? {
          ar: { title: `Google Sheets: توقّف «${name}» بعد سحب الإذن`, body: 'توقّفت الكتابة في الجدول. اربط حساب Google من جديد من التطبيقات ← Google Sheets.' },
          en: { title: `Google Sheets: "${name}" stopped, access was removed`, body: 'New rows are no longer written. Connect the Google account again in Apps → Google Sheets.' },
        }
      : {
          ar: { title: `Google Sheets: الجدول «${name}» غير موجود`, body: 'حُذف الجدول أو نُقل. اختر جدولًا آخر أو احذف الاتصال من التطبيقات ← Google Sheets.' },
          en: { title: `Google Sheets: the sheet "${name}" is gone`, body: 'It was deleted or moved. Pick another sheet or remove the connection in Apps → Google Sheets.' },
        };
  await notifications.create(connection.workspaceId, {
    type: 'integration.failed',
    title: text.ar.title,
    body: text.ar.body,
    localized: text,
    link: '/apps/google-sheets',
    data: { connectionId: connection.id, reason },
    // Once a day at most: a connection resumed and lost again is told again.
    dedupeKey: `sheets:${connection.id}:${reason}:${new Date().toISOString().slice(0, 10)}`,
  });
}

/** What a failed write does to the connection; true when the event should be retried. */
async function recordFailure(connection, err) {
  const message = String(err.message || err).slice(0, 500);
  if (err.code === 'SHEETS_ACCESS_REVOKED' || err.code === 'SHEETS_NOT_FOUND') {
    const status = err.code === 'SHEETS_ACCESS_REVOKED' ? 'revoked' : 'error';
    if (connection.status !== status) {
      await connection.update({ status, lastError: message });
      await alert(connection, status);
    }
    return false;
  }
  await connection.update({ lastError: message });
  return true;
}

/**
 * Writes one entity's rows: rewrites the rows it already has, or appends it
 * when `append` allows. Serialised per connection and entity, so two events
 * for one order cannot both append it.
 */
async function writeEntity(adapter, credentials, connection, entityType, entityId, rows, { append }) {
  return db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext($key))', {
      bind: { key: `sheets:${connection.id}:${entityId}` },
      type: QueryTypes.SELECT,
      transaction,
    });
    const ref = await db.SheetRowRef.findOne({ where: { connectionId: connection.id, entityType, entityId }, transaction });
    const target = { spreadsheetId: connection.spreadsheetId, sheetName: connection.sheetName };
    if (ref) {
      // The rows it was given; fewer lines now leave the extra rows blank.
      const width = rows[0] ? rows[0].length : headerOf(connection).length;
      const fitted = Array.from({ length: ref.rowCount }, (_, i) => rows[i] || Array(width).fill(''));
      await adapter.updateRows(credentials, { ...target, firstRow: ref.rowNumber, rows: fitted });
      await ref.update({ syncedAt: new Date() }, { transaction });
      return 'updated';
    }
    if (!append) return 'skipped';
    const { firstRow } = await adapter.appendRows(credentials, { ...target, rows });
    await db.SheetRowRef.create({ connectionId: connection.id, entityType, entityId, rowNumber: firstRow, rowCount: rows.length, syncedAt: new Date() }, { transaction });
    await connection.increment('rowsWritten', { by: rows.length, transaction });
    return 'appended';
  });
}

// ------------------------------------------------------------------ orders --

/** The order as the export shapes it: with its stage and latest shipment. */
async function orderForSheet(workspaceId, orderId) {
  const order = await require('../orders/orderService').getOrder(workspaceId, orderId);
  const shipments = (order.shipments || []).filter((s) => s.status !== 'cancelled');
  order.shipment = shipments.length ? shipments[shipments.length - 1] : (order.shipments || [])[0] || null;
  return order;
}

function orderMatches(connection, order) {
  const filter = connection.filter || {};
  if (Array.isArray(filter.funnelIds) && filter.funnelIds.length && !filter.funnelIds.includes(order.funnelId)) return false;
  if (Array.isArray(filter.productIds) && filter.productIds.length) {
    if (!(order.items || []).some((i) => filter.productIds.includes(i.productId))) return false;
  }
  return true;
}

function orderRows(order, connection, { timezone }) {
  return require('../orders/orderExportService').rowsForOrder(order, {
    layout: connection.columns,
    rowPer: connection.groupByOrder ? 'order' : 'item',
    lang: (connection.filter || {}).lang === 'en' ? 'en' : 'ar',
    timezone,
    maskPhones: Boolean((connection.filter || {}).maskPhones),
  });
}

async function syncEntity({ workspaceId, dataType, entityId, append, load, rowsOf, matches }) {
  const connections = await db.SheetConnection.findAll({ where: { workspaceId, dataType, status: 'active' } });
  if (connections.length === 0) return { written: 0 };
  // Uninstalling the app stops the writing; the sheets and their settings stay.
  if (!(await appGate.isEnabled(workspaceId, 'google_sheets'))) return { written: 0 };
  const credentials = await credentialsFor(workspaceId);
  if (!credentials) return { written: 0 };
  let entity;
  try {
    entity = await load();
  } catch (err) {
    if (err.statusCode === 404 || err.name === 'NotFoundError') return { written: 0 };
    throw err;
  }
  const adapter = getSheetsAdapter();
  const { timezone } = await settingsOf(workspaceId);
  let retry = null;
  let written = 0;
  for (const connection of connections) {
    if (matches && !matches(connection, entity)) continue;
    try {
      const done = await writeEntity(adapter, credentials, connection, ENTITY[dataType], entityId, rowsOf(entity, connection, { timezone }), { append });
      if (done !== 'skipped') {
        written += 1;
        await connection.update({ lastSyncedAt: new Date(), lastError: null });
      }
    } catch (err) {
      logger.warn('[sheets] write failed', { workspaceId, connectionId: connection.id, entityId, code: err.code, message: err.message });
      if (await recordFailure(connection, err)) retry = err;
    }
  }
  // The outbox tries the event again; rows already written are rewritten in place.
  if (retry) throw retry;
  return { written };
}

/** An order event (jobs.js). */
async function onOrderEvent(event) {
  const payload = event.payload || {};
  const workspaceId = event.workspaceId || payload.workspaceId;
  const orderId = payload.orderId;
  if (!workspaceId || !orderId) return null;
  return syncEntity({
    workspaceId,
    dataType: 'orders',
    entityId: orderId,
    append: event.type === 'order.created',
    load: () => orderForSheet(workspaceId, orderId),
    rowsOf: (order, connection, opts) => orderRows(order, connection, opts),
    matches: orderMatches,
  });
}

/** A lost-order event (jobs.js). */
async function onLostOrderEvent(event) {
  const payload = event.payload || {};
  const workspaceId = event.workspaceId || payload.workspaceId;
  const sessionId = payload.checkoutSessionId;
  if (!workspaceId || !sessionId) return null;
  return syncEntity({
    workspaceId,
    dataType: 'lost_orders',
    entityId: sessionId,
    append: LOST_NEW_EVENTS.includes(event.type),
    load: () => require('../checkoutSessions/lostOrderService').getOne(workspaceId, sessionId),
    rowsOf: (session, connection, opts) => [lostRow(session, connection, { lang: (connection.filter || {}).lang === 'en' ? 'en' : 'ar', ...opts, maskPhones: Boolean((connection.filter || {}).maskPhones) })],
    matches: (connection, session) => {
      const ids = (connection.filter || {}).productIds;
      return !(Array.isArray(ids) && ids.length) || (session.items || []).some((i) => ids.includes(i.productId));
    },
  });
}

/** A sign-up on a contact form or a funnel's opt-in step (jobs.js). */
async function onLeadEvent(event) {
  const payload = event.payload || {};
  const workspaceId = event.workspaceId || payload.workspaceId;
  const submissionId = payload.submissionId;
  if (!workspaceId || !submissionId) return null;
  return syncEntity({
    workspaceId,
    dataType: 'leads',
    entityId: submissionId,
    append: true,
    load: () => leads.loadLead(workspaceId, submissionId),
    rowsOf: (lead, connection, { timezone }) => [leads.leadRow(lead, connection, context((connection.filter || {}).lang === 'en' ? 'en' : 'ar', timezone))],
    matches: leads.leadMatches,
  });
}

// ---------------------------------------------------------------- backfill --

/**
 * "Sync existing" (SPEC §16.4: "for the first time, last 30 days"): what the
 * sheet does not have yet, oldest first, appended in batches. The `io` job.
 */
async function backfill(job) {
  const connection = await db.SheetConnection.findByPk(job.payload && job.payload.connectionId);
  if (!connection || connection.status !== 'active') return null;
  if (!(await appGate.isEnabled(connection.workspaceId, 'google_sheets'))) return null;
  const credentials = await credentialsFor(connection.workspaceId);
  if (!credentials) return null;
  const adapter = getSheetsAdapter();
  const { timezone } = await settingsOf(connection.workspaceId);
  const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const entityType = ENTITY[connection.dataType];
  const done = new Set(
    (await db.SheetRowRef.findAll({ where: { connectionId: connection.id, entityType }, attributes: ['entityId'] })).map((r) => r.entityId)
  );

  let ids;
  if (connection.dataType === 'orders') {
    ids = (
      await db.Order.findAll({
        where: { workspaceId: connection.workspaceId, createdAt: { [Op.gte]: since } },
        attributes: ['id'],
        order: [['createdAt', 'ASC']],
        limit: BACKFILL_MAX,
      })
    ).map((o) => o.id);
  } else if (connection.dataType === 'leads') {
    ids = await leads.leadIdsSince(connection.workspaceId, since, BACKFILL_MAX);
  } else {
    ids = (
      await db.sequelize.query(
        `SELECT id FROM checkout_sessions
          WHERE workspace_id = $workspaceId AND last_activity_at >= $since
            AND (abandoned_event_at IS NOT NULL OR lost_reason IS NOT NULL)
          ORDER BY last_activity_at ASC LIMIT $limit`,
        { bind: { workspaceId: connection.workspaceId, since, limit: BACKFILL_MAX }, type: QueryTypes.SELECT }
      )
    ).map((r) => r.id);
  }
  const pending = ids.filter((id) => !done.has(id));

  let appended = 0;
  try {
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = [];
      for (const id of pending.slice(i, i + BATCH)) {
        try {
          if (connection.dataType === 'orders') {
            const order = await orderForSheet(connection.workspaceId, id);
            if (orderMatches(connection, order)) batch.push({ id, rows: orderRows(order, connection, { timezone }) });
          } else if (connection.dataType === 'leads') {
            const lead = await leads.loadLead(connection.workspaceId, id);
            if (leads.leadMatches(connection, lead)) batch.push({ id, rows: [leads.leadRow(lead, connection, context((connection.filter || {}).lang === 'en' ? 'en' : 'ar', timezone))] });
          } else {
            const session = await require('../checkoutSessions/lostOrderService').getOne(connection.workspaceId, id);
            batch.push({ id, rows: [lostRow(session, connection, { lang: (connection.filter || {}).lang === 'en' ? 'en' : 'ar', timezone, maskPhones: Boolean((connection.filter || {}).maskPhones) })] });
          }
        } catch (err) {
          logger.warn('[sheets] backfill skipped one', { connectionId: connection.id, id, message: err.message });
        }
      }
      if (batch.length === 0) continue;
      const { firstRow } = await adapter.appendRows(credentials, { spreadsheetId: connection.spreadsheetId, sheetName: connection.sheetName, rows: batch.flatMap((b) => b.rows) });
      let row = firstRow;
      const refs = batch.map((b) => {
        const ref = { connectionId: connection.id, entityType, entityId: b.id, rowNumber: row, rowCount: b.rows.length, syncedAt: new Date() };
        row += b.rows.length;
        return ref;
      });
      // One the live sync wrote meanwhile keeps its own ref (its row is there twice).
      await db.SheetRowRef.bulkCreate(refs, { ignoreDuplicates: true });
      appended += row - firstRow;
    }
    await connection.update({ lastSyncedAt: new Date(), lastError: null, rowsWritten: connection.rowsWritten + appended });
  } catch (err) {
    await recordFailure(connection, err);
    if (appended) await connection.update({ rowsWritten: connection.rowsWritten + appended });
  }
  return { appended };
}

module.exports = {
  ORDER_UPDATE_EVENTS,
  LOST_NEW_EVENTS,
  LOST_COLUMNS,
  LOST_KEYS,
  LEAD_COLUMNS: leads.LEAD_COLUMNS,
  LEAD_KEYS: leads.LEAD_KEYS,
  BACKFILL_DAYS,
  headerOf,
  credentialsFor,
  onOrderEvent,
  onLostOrderEvent,
  onLeadEvent,
  backfill,
};
