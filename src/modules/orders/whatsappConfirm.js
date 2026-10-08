'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');

/**
 * POST /orders/:orderId/whatsapp-confirm — "Confirm via WhatsApp" on the
 * order page (SPEC §4.4).
 *
 *   WhatsApp connected   sends the `order_confirmation` template (the one the
 *                        ready-made automation uses, with "Confirm order" and
 *                        "Cancel" buttons) about this order; the customer's tap
 *                        confirms or cancels it (whatsapp/quickReplyConfirmation.js)
 *   not connected        answers a wa.me link with the same message written
 *                        out, for the merchant to send from their own phone
 *
 * A failed send (the template not approved yet, a number not on WhatsApp)
 * is Meta's error, with the wa.me link in its details so the dashboard can
 * offer it instead. A cancelled or already confirmed order is refused.
 */

const TEMPLATE = 'order_confirmation';

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required(), orderId: Joi.string().uuid().required() }),
  body: Joi.object({}),
};

// The template's body (automationTemplates.js), written out for wa.me — in English for an English order (item 383).
const messageFor = (vars, lang = 'ar') =>
  lang === 'en'
    ? `Hi ${vars.customer_name || ''}, we received your order ${vars.order_number} for ${vars.order_total}. Please confirm the order so we can start preparing it.`.replace(/\s+,/, ',')
    : `مرحبًا ${vars.customer_name || ''}، استلمنا طلبك رقم ${vars.order_number} بإجمالي ${vars.order_total}. من فضلك أكّد الطلب لنبدأ تجهيزه.`.replace(
        /\s+،/,
        '،'
      );

async function whatsappConfirm(workspaceId, orderId, req) {
  // Lazy: automations and whatsapp reach back into orders.
  const { loadOrderSubject } = require('../automations/automationContext');
  const whatsapp = require('../whatsapp/whatsappService');

  const subject = await loadOrderSubject(workspaceId, orderId);
  if (!subject) throw new NotFoundError('Order');
  const { order, vars } = subject;
  if (order.cancelledAt || order.confirmationState === 'rejected') throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
  if (order.confirmationState === 'confirmed') throw new AppError('ORDER_ALREADY_CONFIRMED', 'This order is already confirmed', 409);
  const phone = normalizePhone(subject.phone);
  if (!phone) throw new AppError('INVALID_PHONE', 'The order has no valid phone number', 422);

  // The order's language (orders.locale, item 383): the wa.me text and, when approved in it, the template.
  const lang = require('./orderLocale').textLang(order.locale, await require('./orderLocale').loadWorkspace(workspaceId));
  const message = messageFor(vars, lang);
  const link = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  const integration = await whatsapp.getIntegration(workspaceId);
  const connected = Boolean(integration && integration.status === 'connected');

  let sent = null;
  if (connected) {
    try {
      sent = await whatsapp.sendMessage(
        workspaceId,
        {
          to: phone,
          orderId: order.id,
          template: { name: TEMPLATE, language: await require('../whatsapp/templateLanguage').languageFor(workspaceId, TEMPLATE, order.locale, 'ar'), params: [vars.customer_name, vars.order_number, vars.order_total] },
        },
        req
      );
    } catch (err) {
      if (err instanceof AppError) {
        err.details = { ...(err.details && typeof err.details === 'object' && !Array.isArray(err.details) ? err.details : {}), link };
      }
      throw err;
    }
  }

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'order.whatsapp_confirm',
    entityType: 'Order',
    entityId: order.id,
    metadata: { channel: connected ? 'whatsapp' : 'link', ...(sent ? { messageId: sent.id } : {}) },
    req,
  });
  return connected
    ? { channel: 'whatsapp', template: TEMPLATE, messageId: sent.id, status: sent.status, link }
    : { channel: 'link', link, message };
}

const handler = asyncHandler(async (req, res) => res.json(await whatsappConfirm(req.tenant.workspaceId, req.params.orderId, req)));

module.exports = { schema, whatsappConfirm, handler };
