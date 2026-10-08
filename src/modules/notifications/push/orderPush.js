'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const validate = require('../../../core/middleware/validate');
const { workspaceRef } = require('../../../core/utils/workspaceSlug');
const { NotFoundError, AppError } = require('../../../core/errors/AppError');
const { getProvider } = require('./index');

/**
 * Push to shoppers about their order (SPEC §20.2, the store's PWA). On the
 * thank-you page a shopper may ask for updates: that browser follows that one
 * order, proven by the order number the page shows. The store's app must be
 * on (storefront/storeApp.js) — its service worker is what shows the push.
 *
 *   GET  /store/:ws/push-config                 { available, publicKey }
 *   POST /store/:ws/orders/:orderId/push        { number, token, platform }
 *
 * Then confirmation, shipping, out for delivery, delivery and cancellation
 * are pushed in the store's language with a link to the order's tracking
 * page. Sent through the push provider (README.md): with the sandbox each
 * push is written to the notification log.
 */

const MAX_PER_ORDER = 5;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const MESSAGES = {
  'order.confirmed': { ar: ['تم تأكيد طلبك', 'طلبك {n} اتأكد وهيتجهز للشحن.'], en: ['Your order is confirmed', 'Order {n} is confirmed and being prepared.'] },
  'order.shipped': { ar: ['طلبك اتشحن', 'طلبك {n} خرج مع شركة الشحن.'], en: ['Your order has shipped', 'Order {n} is on its way.'] },
  'order.out_for_delivery': { ar: ['طلبك في الطريق إليك', 'المندوب في الطريق بطلبك {n} النهارده.'], en: ['Out for delivery', 'Order {n} arrives today.'] },
  'order.delivered': { ar: ['تم توصيل طلبك', 'وصل طلبك {n}. شكرًا لثقتك!'], en: ['Delivered', 'Order {n} was delivered. Thank you!'] },
  'order.cancelled': { ar: ['تم إلغاء طلبك', 'طلبك {n} اتلغى.'], en: ['Order cancelled', 'Order {n} was cancelled.'] },
  // Item 372: the answer to the shopper's return or exchange.
  'return.approved': { ar: ['تمت الموافقة على الإرجاع', 'طلب الإرجاع أو الاستبدال لطلبك {n} اتقبل. التفاصيل في صفحة الطلب.'], en: ['Return approved', 'Your return or exchange for order {n} was approved. See the order page for the next step.'] },
  'return.rejected': { ar: ['بخصوص طلب الإرجاع', 'طلب الإرجاع أو الاستبدال لطلبك {n} ماتقبلش. السبب في صفحة الطلب.'], en: ['Return not accepted', 'Your return or exchange for order {n} was not accepted. See the order page for why.'] },
};
const EVENTS = Object.keys(MESSAGES);

const storeAppOn = (workspace) => Boolean(workspace && workspace.settings && workspace.settings.store_app && workspace.settings.store_app.enabled === true);

/** Sends the event's message to every browser following the order. Never throws. */
async function sendForEvent(event) {
  const orderId = event.payload && event.payload.orderId;
  const text = MESSAGES[event.type];
  // The staff chose not to tell the customer about this change (as the automations).
  if (!orderId || !text || event.payload.notifyCustomer === false) return { sent: 0 };
  const provider = getProvider();
  if (!provider) return { sent: 0 };
  const subscriptions = await db.OrderPushSubscription.findAll({ where: { orderId, workspaceId: event.workspaceId } });
  if (subscriptions.length === 0) return { sent: 0 };
  const [order, workspace] = await Promise.all([
    db.Order.findOne({ where: { id: orderId, workspaceId: event.workspaceId } }),
    db.Workspace.findByPk(event.workspaceId, { attributes: ['id', 'slug', 'defaultLocale', 'settings'] }),
  ]);
  if (!order || !storeAppOn(workspace)) return { sent: 0 };
  const lang = String(workspace.defaultLocale || 'ar').startsWith('en') ? 'en' : 'ar';
  const [title, body] = text[lang];
  const tracking = require('../../storefront/orderTrackingExtras').tokenFor(order);
  const message = {
    workspaceId: workspace.id,
    type: `shopper.${event.type}`,
    // Logged with the order by the provider (the order's timeline).
    orderId: order.id,
    title,
    body: body.replace('{n}', order.orderNumber),
    // The store's canonical address (its primary domain when it has one).
    link: `${await require('../../domains/primaryHost').storeOriginOf(workspace)}/track?t=${tracking}`,
  };
  let sent = 0;
  for (const subscription of subscriptions) {
    try {
      await provider.send(subscription, message);
      await subscription.update({ lastSentAt: new Date() });
      sent += 1;
    } catch (err) {
      if (err && err.gone) await subscription.destroy().catch(() => {});
      else logger.warn('Shopper push failed', { orderId, subscriptionId: subscription.id, message: err.message });
    }
  }
  return { sent };
}

// ---------------------------------------------------------------- routes --

// Inside the public store router (resolvePublicWorkspace has run).
const router = Router({ mergeParams: true });
const workspaceId = workspaceRef().required();

router.get(
  '/push-config',
  validate({ params: Joi.object({ workspaceId }) }),
  asyncHandler(async (req, res) => {
    const provider = getProvider();
    const on = Boolean(provider) && storeAppOn(req.publicWorkspace);
    res.json({ push: { available: on, publicKey: on ? provider.publicKey() : null } });
  })
);

router.post(
  '/orders/:orderId/push',
  validate({
    params: Joi.object({ workspaceId, orderId: Joi.string().uuid().required() }),
    body: Joi.object({
      number: Joi.string().trim().max(40).required(),
      platform: Joi.string().valid('web').default('web'),
      token: Joi.string().min(8).max(4000).required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ws = req.tenant.workspaceId;
    const provider = getProvider();
    if (!provider || !storeAppOn(req.publicWorkspace)) throw new AppError('PUSH_UNAVAILABLE', 'This store does not send notifications', 409);
    if (provider.checkToken) provider.checkToken(req.body.platform, req.body.token);
    const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId: ws }, attributes: ['id', 'orderNumber'] });
    if (!order || order.orderNumber.toLowerCase() !== req.body.number.toLowerCase()) throw new NotFoundError('Order');
    const tokenHash = hash(req.body.token);
    const existing = await db.OrderPushSubscription.findOne({ where: { orderId: order.id, tokenHash } });
    if (!existing) {
      const count = await db.OrderPushSubscription.count({ where: { orderId: order.id } });
      if (count >= MAX_PER_ORDER) throw new AppError('PUSH_LIMIT', 'This order already has the most devices following it', 409);
      await db.OrderPushSubscription.create({ workspaceId: ws, orderId: order.id, platform: req.body.platform, token: req.body.token, tokenHash });
    }
    res.status(201).json({ subscribed: true });
  })
);

module.exports = { router, sendForEvent, EVENTS };
