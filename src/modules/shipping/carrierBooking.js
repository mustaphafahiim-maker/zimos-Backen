'use strict';

const Joi = require('joi');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const carriers = require('./carriers');

/**
 * How a connected courier books (SPEC §12.2): the store's default courier,
 * automatic booking once an order is confirmed or paid, parcel inspection
 * on delivery and standing notes for the courier (migration 180).
 *
 * Automatic booking runs on order.confirmed / order.paid (shipping/jobs.js)
 * and is never retried: a courier create cannot be undone by a retry (it
 * could book the parcel twice). When it cannot book — the address does not
 * match the courier's list, the courier refuses, the order is not ready —
 * the merchant gets a notification and the reason on the order's
 * timeline, and books it by hand.
 */

const AUTO_CREATE_ON = ['never', 'confirmed', 'paid'];
const TRIGGER_FOR = { 'order.confirmed': 'confirmed', 'order.paid': 'paid' };

const bookingSchema = Joi.object({
  isDefault: Joi.boolean().optional(),
  autoCreateOn: Joi.string().valid(...AUTO_CREATE_ON).optional(),
  allowInspection: Joi.boolean().optional(),
  courierNotes: Joi.string().trim().max(500).allow('', null).optional(),
}).min(1);

const view = (account) => ({
  carrierCode: account.carrierCode,
  isDefault: Boolean(account.isDefault),
  autoCreateOn: account.autoCreateOn || 'never',
  allowInspection: Boolean(account.allowInspection),
  courierNotes: account.courierNotes || null,
});

/** PATCH /carriers/:code/booking — one courier the default turns every other off. */
async function updateBooking(workspaceId, code, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const account = await db.CarrierAccount.findOne({ where: { workspaceId, carrierCode: code }, transaction, lock: transaction.LOCK.UPDATE });
    if (!account) throw new NotFoundError('Carrier connection');
    const before = view(account);
    const changes = {};
    if (body.isDefault !== undefined) changes.isDefault = body.isDefault;
    if (body.autoCreateOn !== undefined) changes.autoCreateOn = body.autoCreateOn;
    if (body.allowInspection !== undefined) changes.allowInspection = body.allowInspection;
    if (body.courierNotes !== undefined) changes.courierNotes = body.courierNotes ? body.courierNotes : null;
    if (changes.isDefault) {
      // Every other courier stops being the default (this row is left out: its
      // own update below would see no change against the loaded instance).
      await db.CarrierAccount.update({ isDefault: false }, { where: { workspaceId, isDefault: true, id: { [Op.ne]: account.id } }, transaction });
    }
    await account.update(changes, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'carrier_account.booking_update',
      entityType: 'CarrierAccount',
      entityId: account.id,
      before,
      after: view(account),
      req,
      transaction,
    });
    return view(account);
  });
}

/**
 * The courier that books an order on its own at this moment: the default
 * one when it is set to, otherwise the only one that is. Null: none.
 */
async function autoCourierFor(workspaceId, moment) {
  const accounts = await db.CarrierAccount.findAll({ where: { workspaceId, autoCreateOn: moment, status: 'active' } });
  const usable = [];
  for (const account of accounts) {
    if (await carriers.adapterFor(account.carrierCode, workspaceId)) usable.push(account);
  }
  return usable.find((a) => a.isDefault) || (usable.length === 1 ? usable[0] : null);
}

async function tellMerchant(workspaceId, order, courier, reason) {
  try {
    await recordAudit({
      workspaceId,
      actorUserId: null,
      action: 'shipment.auto_booking_failed',
      entityType: 'Order',
      entityId: order.id,
      metadata: { carrierCode: courier, reason: String(reason).slice(0, 300) },
    });
    // One notification per order (the generic integration.failed one is once a day per courier).
    const adapter = carriers.getAdapter(courier);
    await require('../notifications/merchantNotificationService').create(workspaceId, {
      type: 'integration.failed',
      title: `لم يُحجز الأوردر ${order.orderNumber} تلقائيًا مع ${adapter ? adapter.name : courier}`,
      body: `${String(reason).slice(0, 300)}\nاحجزه من صفحة الأوردر.`,
      link: `/orders/${order.id}`,
      data: {
        integration: adapter ? adapter.name : courier,
        carrierCode: courier,
        orderId: order.id,
        orderNumber: order.orderNumber,
        reason: String(reason).slice(0, 300),
      },
      dedupeKey: `auto_booking:${order.id}`,
    });
  } catch (err) {
    logger.error('Could not report a failed automatic booking', { workspaceId, orderId: order.id, message: err.message });
  }
}

/** The outbox consumer: books the order with the store's automatic courier, once. */
async function autoBook(event) {
  const moment = TRIGGER_FOR[event.type];
  const orderId = event.payload && event.payload.orderId;
  if (!moment || !orderId) return null;
  const { workspaceId } = event;
  const account = await autoCourierFor(workspaceId, moment);
  if (!account) return null;

  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order || order.cancelledAt) return null;
  // A test order goes to a real courier only by hand; the sandbox courier takes it.
  if (order.isTest && account.carrierCode !== 'sandbox') return null;
  // order.confirmed of an online order that is not paid yet waits for order.paid.
  if (await db.Shipment.count({ where: { orderId, status: ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'] } })) return null;

  try {
    const shipment = await require('./carrierShipmentService').createCarrierShipment(
      workspaceId,
      orderId,
      { carrierCode: account.carrierCode, automatic: moment },
      null
    );
    logger.info('Order booked automatically', { workspaceId, orderId, carrierCode: account.carrierCode, waybill: shipment.waybillNumber });
    return { booked: shipment.waybillNumber };
  } catch (err) {
    // Not retried (see the top of this file): the merchant books it by hand.
    await tellMerchant(workspaceId, order, account.carrierCode, err.message);
    logger.warn('Automatic booking failed', { workspaceId, orderId, carrierCode: account.carrierCode, code: err.code, message: err.message });
    return { failed: err.code || err.message };
  }
}

module.exports = { AUTO_CREATE_ON, bookingSchema, updateBooking, autoBook, autoCourierFor };
