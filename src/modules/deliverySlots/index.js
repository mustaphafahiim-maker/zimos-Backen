'use strict';

const { Router } = require('express');
const Joi = require('joi');
const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const { Op, QueryTypes } = require('sequelize');
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
 * Delivery date and time slots at checkout (spec-gaps item 221).
 * settings.delivery_slots = {
 *   enabled, required,
 *   leadDays,            // the earliest day offered: 0 = today, 1 = tomorrow…
 *   cutoffTime | null,   // 'HH:MM' store time: after it, the earliest day moves one day later
 *   sameDayNoticeMinutes,// a slot today is offered only if it starts at least this far ahead
 *   horizonDays,         // how many days ahead the shopper can choose
 *   weekly: { '0'..'6': [{ id, from: 'HH:MM', to: 'HH:MM', capacity | null }] },  // 0 = Sunday
 *   closedDates: ['YYYY-MM-DD'],
 *   note: { ar, en } | null,
 * }
 * Dates and times are the store's own (workspace.timezone). A slot's capacity
 * counts the orders booked into it on that date; a cancelled order frees its
 * place. Checkout body: `deliverySlot: { date: 'YYYY-MM-DD', slotId }`.
 * The choice is kept in delivery_slot_bookings and on the order
 * (shippingSnapshot.deliverySlot), and printed on the waybill.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// A booking held for a checkout that never made its order stops counting after this.
const HOLD_MS = 10 * 60 * 1000;

const DEFAULTS = { enabled: false, required: false, leadDays: 1, cutoffTime: null, sameDayNoticeMinutes: 120, horizonDays: 7, weekly: {}, closedDates: [], note: null };

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.delivery_slots) || {};
  return { ...DEFAULTS, ...s };
}

// ------------------------------------------------------------ calendar --

function localParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Booked places per `${date}|${slotId}` between two dates. Cancelled orders and stale holds don't count. */
async function bookedCounts(workspaceId, fromDate, toDate, transaction) {
  const rows = await db.sequelize.query(
    `SELECT b.delivery_date AS date, b.slot_id AS "slotId", count(*)::int AS n
       FROM delivery_slot_bookings b
       LEFT JOIN orders o ON o.id = b.order_id
      WHERE b.workspace_id = :workspaceId AND b.delivery_date BETWEEN :fromDate AND :toDate
        AND ((b.order_id IS NOT NULL AND o.cancelled_at IS NULL) OR (b.order_id IS NULL AND b.created_at > :staleBefore))
      GROUP BY 1, 2`,
    { replacements: { workspaceId, fromDate, toDate, staleBefore: new Date(Date.now() - HOLD_MS) }, type: QueryTypes.SELECT, transaction }
  );
  return new Map(rows.map((r) => [`${String(r.date).slice(0, 10)}|${r.slotId}`, r.n]));
}

/** The days and slots on offer now, with the places left. */
async function calendar(workspace, now = new Date()) {
  const s = settingsOf(workspace);
  const tz = workspace.timezone || 'Africa/Cairo';
  const local = localParts(now, tz);
  let first = s.leadDays;
  if (s.cutoffTime && local.minutes >= minutesOf(s.cutoffTime)) first += 1;
  const lastDate = addDays(local.ymd, s.leadDays + s.horizonDays - 1 + (first - s.leadDays));
  const counts = await bookedCounts(workspace.id, addDays(local.ymd, first), lastDate);
  const closed = new Set(s.closedDates || []);
  const days = [];
  for (let i = first; i < first + s.horizonDays; i += 1) {
    const date = addDays(local.ymd, i);
    if (closed.has(date)) continue;
    const slots = (s.weekly[String(weekdayOf(date))] || [])
      .filter((slot) => i > 0 || minutesOf(slot.from) >= local.minutes + s.sameDayNoticeMinutes)
      .map((slot) => {
        const booked = counts.get(`${date}|${slot.id}`) || 0;
        const remaining = slot.capacity == null ? null : Math.max(0, slot.capacity - booked);
        return { id: slot.id, from: slot.from, to: slot.to, capacity: slot.capacity == null ? null : slot.capacity, booked, remaining, available: remaining == null || remaining > 0 };
      });
    if (slots.length) days.push({ date, weekday: weekdayOf(date), slots });
  }
  return { timezone: tz, days };
}

/** What the storefront shows (GET /store/:ws/delivery-slots): null when off. */
async function publicView(workspace) {
  const s = settingsOf(workspace);
  if (!s.enabled) return null;
  const { timezone, days } = await calendar(workspace);
  return {
    required: Boolean(s.required),
    note: s.note || null,
    timezone,
    days: days.map((d) => ({ date: d.date, weekday: d.weekday, slots: d.slots.map((x) => ({ id: x.id, from: x.from, to: x.to, available: x.available })) })),
  };
}

// ------------------------------------------------------------ checkout --

/**
 * Checkout, before the order: checks the chosen slot and holds a place in it
 * (a row without an order yet). Returns the held booking, or null when the
 * store has no slots or none was chosen and none is required.
 */
async function hold(workspace, choice) {
  const s = settingsOf(workspace);
  if (!s.enabled) {
    if (choice) throw new ValidationError([{ field: 'deliverySlot', message: 'This store does not offer delivery times' }], 'Invalid body');
    return null;
  }
  if (!choice) {
    if (s.required) throw new ValidationError([{ field: 'deliverySlot', message: 'Choose a delivery day and time' }], 'Invalid body');
    return null;
  }
  // Which slots are offered, read before the transaction (item 281): inside it, this would take a second
  // pool connection while the first waits on the lock — ten checkouts at once would drain the pool.
  const { days } = await calendar(workspace);
  const day = days.find((d) => d.date === choice.date);
  const slot = day && day.slots.find((x) => x.id === choice.slotId);
  if (!slot) throw new AppError('DELIVERY_SLOT_UNAVAILABLE', 'This delivery time is not offered; choose another', 409);
  return db.sequelize.transaction(async (transaction) => {
    // One checkout at a time per store counts and takes a place.
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `delivery-slots:${workspace.id}` }, transaction });
    // calendar() ran outside the transaction; count again inside the lock.
    const booked = (await bookedCounts(workspace.id, choice.date, choice.date, transaction)).get(`${choice.date}|${slot.id}`) || 0;
    if (slot.capacity != null && booked >= slot.capacity) throw new AppError('DELIVERY_SLOT_FULL', 'This delivery time is fully booked; choose another', 409);
    return db.DeliverySlotBooking.create({ workspaceId: workspace.id, deliveryDate: choice.date, slotId: slot.id, startsAt: slot.from, endsAt: slot.to }, { transaction });
  });
}

/** After the order exists: the held place becomes the order's. */
async function attach(order, booking) {
  if (!booking) return;
  await booking.update({ orderId: order.id });
  const fresh = await db.Order.findByPk(order.id, { attributes: ['id', 'shippingSnapshot'] });
  const deliverySlot = { date: booking.deliveryDate, slotId: booking.slotId, from: booking.startsAt, to: booking.endsAt };
  await fresh.update({ shippingSnapshot: { ...(fresh.shippingSnapshot || {}), deliverySlot } }, { hooks: false });
  order.shippingSnapshot = fresh.shippingSnapshot;
}

/** The waybill's line (waybill/customData.js). */
function waybillLines(order) {
  const d = order && order.shippingSnapshot && order.shippingSnapshot.deliverySlot;
  return d ? [`DELIVER ON / التوصيل: ${d.date} ${d.from}-${d.to}`] : [];
}

// ---------------------------------------------------------------- staff --

const slotSchema = Joi.object({
  id: Joi.string().trim().max(40).pattern(/^[A-Za-z0-9_-]+$/),
  from: Joi.string().pattern(HHMM).required(),
  to: Joi.string().pattern(HHMM).required(),
  capacity: Joi.number().integer().min(1).max(10000).allow(null).default(null),
});
const settingsBody = Joi.object({
  enabled: Joi.boolean().required(),
  required: Joi.boolean().default(false),
  leadDays: Joi.number().integer().min(0).max(30).default(1),
  cutoffTime: Joi.string().pattern(HHMM).allow(null).default(null),
  sameDayNoticeMinutes: Joi.number().integer().min(0).max(1440).default(120),
  horizonDays: Joi.number().integer().min(1).max(60).default(7),
  weekly: Joi.object().pattern(Joi.string().valid('0', '1', '2', '3', '4', '5', '6'), Joi.array().items(slotSchema).max(12)).default({}),
  closedDates: Joi.array().items(Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).max(366).unique().default([]),
  note: Joi.object({ ar: Joi.string().trim().max(300).allow(''), en: Joi.string().trim().max(300).allow('') }).allow(null).default(null),
});

function checkWeekly(weekly) {
  const errors = [];
  for (const [day, slots] of Object.entries(weekly)) {
    const ids = new Set();
    slots.forEach((slot, i) => {
      // A slot without an id gets one, so bookings keep pointing at it after edits.
      if (!slot.id) slot.id = crypto.randomBytes(4).toString('hex');
      if (ids.has(slot.id)) errors.push({ field: `weekly.${day}.${i}.id`, message: 'Each slot of a day needs its own id' });
      ids.add(slot.id);
      if (minutesOf(slot.to) <= minutesOf(slot.from)) errors.push({ field: `weekly.${day}.${i}.to`, message: 'A slot must end after it starts' });
    });
  }
  if (errors.length) throw new ValidationError(errors);
}

// Mounted at /api/v1/workspaces/:workspaceId/delivery-slots.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const loadWorkspace = (req) => db.Workspace.findByPk(req.tenant.workspaceId);

staff.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(settingsOf(await loadWorkspace(req)))));
staff.put(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws), body: settingsBody }),
  asyncHandler(async (req, res) => {
    checkWeekly(req.body.weekly);
    const workspace = await loadWorkspace(req);
    const next = { ...req.body, closedDates: [...req.body.closedDates].sort() };
    await workspace.update({ settings: { ...(workspace.settings || {}), delivery_slots: next } });
    require('../storefront/storefrontCache').invalidate(workspace.id);
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'delivery_slots.update', entityType: 'Workspace', entityId: workspace.id, after: next, req });
    res.json(settingsOf(workspace));
  })
);

// The team's delivery plan: every booked order per day and slot.
staff.get(
  '/schedule',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({ params: Joi.object(ws), query: Joi.object({ from: Joi.string().isoDate().required(), to: Joi.string().isoDate().required() }) }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if ((new Date(to) - new Date(from)) / 86400000 > 62) throw new ValidationError([{ field: 'to', message: 'At most 62 days at a time' }]);
    const rows = await db.DeliverySlotBooking.findAll({
      where: { workspaceId: req.tenant.workspaceId, orderId: { [Op.ne]: null }, deliveryDate: { [Op.between]: [from.slice(0, 10), to.slice(0, 10)] } },
      include: [{ model: db.Order, as: 'order', attributes: ['id', 'orderNumber', 'totalAmount', 'currency', 'contactSnapshot', 'cancelledAt'], where: { cancelledAt: null } }],
      order: [['deliveryDate', 'ASC'], ['startsAt', 'ASC'], ['createdAt', 'ASC']],
    });
    const days = new Map();
    for (const b of rows) {
      if (!days.has(b.deliveryDate)) days.set(b.deliveryDate, new Map());
      const slots = days.get(b.deliveryDate);
      const key = `${b.slotId}|${b.startsAt}|${b.endsAt}`;
      if (!slots.has(key)) slots.set(key, { slotId: b.slotId, from: b.startsAt, to: b.endsAt, orders: [] });
      const o = b.order;
      slots.get(key).orders.push({ id: o.id, orderNumber: o.orderNumber, totalAmount: String(o.totalAmount), currency: o.currency, customerName: (o.contactSnapshot && o.contactSnapshot.fullName) || null });
    }
    res.json({ days: [...days].map(([date, slots]) => ({ date, slots: [...slots.values()] })) });
  })
);

// The team moves an order to another day/slot (the shopper asked, or the
// store can't make it). Capacity is checked unless `force`.
staff.put(
  '/orders/:orderId',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({
    params: Joi.object({ ...ws, orderId: Joi.string().uuid().required() }),
    body: Joi.object({ date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null).required(), slotId: Joi.string().max(40).when('date', { is: null, then: Joi.forbidden(), otherwise: Joi.required() }), force: Joi.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req);
    const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId: workspace.id }, attributes: ['id', 'shippingSnapshot'] });
    if (!order) throw new NotFoundError('Order');
    const before = (order.shippingSnapshot && order.shippingSnapshot.deliverySlot) || null;
    let after = null;
    await db.sequelize.transaction(async (transaction) => {
      await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `delivery-slots:${workspace.id}` }, transaction });
      await db.DeliverySlotBooking.destroy({ where: { orderId: order.id }, transaction });
      if (req.body.date) {
        const s = settingsOf(workspace);
        const slot = (s.weekly[String(weekdayOf(req.body.date))] || []).find((x) => x.id === req.body.slotId);
        if (!slot) throw new ValidationError([{ field: 'slotId', message: 'The store has no such slot on that day' }]);
        if (!req.body.force && slot.capacity != null) {
          const booked = (await bookedCounts(workspace.id, req.body.date, req.body.date, transaction)).get(`${req.body.date}|${slot.id}`) || 0;
          if (booked >= slot.capacity) throw new AppError('DELIVERY_SLOT_FULL', 'This delivery time is fully booked; send force: true to book it anyway', 409);
        }
        await db.DeliverySlotBooking.create({ workspaceId: workspace.id, orderId: order.id, deliveryDate: req.body.date, slotId: slot.id, startsAt: slot.from, endsAt: slot.to }, { transaction });
        after = { date: req.body.date, slotId: slot.id, from: slot.from, to: slot.to };
      }
      const snapshot = { ...(order.shippingSnapshot || {}) };
      if (after) snapshot.deliverySlot = after;
      else delete snapshot.deliverySlot;
      await order.update({ shippingSnapshot: snapshot }, { hooks: false, transaction });
    });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'order.delivery_slot_change', entityType: 'Order', entityId: order.id, before: { deliverySlot: before }, after: { deliverySlot: after }, req });
    res.json({ deliverySlot: after });
  })
);

// Mounted at /api/v1/store/:workspaceId/delivery-slots (public).
const store = Router({ mergeParams: true });
store.get('/', resolvePublicWorkspace, asyncHandler(async (req, res) => {
  const view = await publicView(req.publicWorkspace);
  if (!view) throw new NotFoundError('Delivery slots');
  res.set('Cache-Control', 'no-store');
  res.json(view);
}));

module.exports = { staff, store, hold, attach, waybillLines, publicView, calendar, settingsOf };
