'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('./notify');
const emailTemplates = require('./emailTemplates');

/**
 * Order emails (SPEC §14.5): the emails a store's customers get about their
 * orders, sent through the existing email provider under the store's name.
 *
 * Each template has a key, the event that sends it, and a built-in Arabic
 * subject and body. A store may switch it on, and rewrite the subject and
 * body with {{variables}} — the same ones automations use. They all start
 * switched off: email matters less than WhatsApp in a COD market (most
 * orders carry no address), and nothing should start emailing a store's
 * customers until its merchant says so. An order without an email address is
 * simply skipped.
 *
 * Out of scope here (§14 scope boundary): verifying the merchant's own
 * sending domain. Emails go from the platform's address with the store's
 * name as the sender name.
 */

const TEMPLATES = Object.freeze({
  order_confirmation: {
    event: 'order.created',
    subject: 'تم استلام طلبك {{order_number}}',
    body: 'مرحبًا {{customer_name}}،\n\nشكرًا لطلبك من {{store_name}}. استلمنا طلبك رقم {{order_number}} بإجمالي {{order_total}}.\n\nالمنتجات: {{product_names}}\n\nيمكنك متابعة الطلب من هنا:\n{{order_link}}',
  },
  order_shipped: {
    event: 'order.shipped',
    subject: 'طلبك {{order_number}} في الطريق إليك',
    body: 'مرحبًا {{customer_name}}،\n\nتم شحن طلبك رقم {{order_number}} مع {{carrier_name}}.\nرقم البوليصة: {{waybill_number}}\n\nتابع الشحنة من هنا:\n{{order_link}}',
  },
  order_cancelled: {
    event: 'order.cancelled',
    subject: 'تم إلغاء طلبك {{order_number}}',
    body: 'مرحبًا {{customer_name}}،\n\nتم إلغاء طلبك رقم {{order_number}} من {{store_name}}. إذا كان ذلك بالخطأ يسعدنا أن تطلب من جديد.',
  },
  order_refunded: {
    event: 'order.refunded',
    subject: 'تم رد مبلغ طلبك {{order_number}}',
    body: 'مرحبًا {{customer_name}}،\n\nتم رد مبلغ طلبك رقم {{order_number}}. قد يستغرق ظهوره في حسابك عدة أيام عمل حسب وسيلة الدفع.',
  },
  abandoned_cart: {
    event: 'checkout.abandoned',
    subject: 'طلبك من {{store_name}} في انتظارك',
    body: 'مرحبًا {{customer_name}}،\n\nلاحظنا أنك لم تكمل طلبك من {{store_name}}. ما زال محفوظًا، ويمكنك إكماله من هنا:\n{{recovery_link}}',
  },
  digital_delivery: {
    event: 'order.digital_delivered',
    subject: 'منتجك الرقمي من {{store_name}} جاهز',
    body: 'مرحبًا {{customer_name}}،\n\nشكرًا لطلبك رقم {{order_number}}. يمكنك الوصول إلى مشترياتك الرقمية من هنا:\n{{order_link}}',
  },
});
const KEYS = Object.keys(TEMPLATES);
const EVENTS = [...new Set(KEYS.map((k) => TEMPLATES[k].event))];

// Lazy: automationContext pulls in order models that reach back here through notify.
const context = () => require('../automations/automationContext');

const SAMPLE_VARS = Object.freeze({
  customer_name: 'منى أحمد',
  order_number: 'ORD-1042',
  order_total: '850 EGP',
  store_name: '',
  tracking_url: 'https://example.com/track/ZG123456789',
  city: 'القاهرة',
  product_names: 'قميص كتان أزرق، حزام جلد',
  items_count: 2,
  shipping_amount: '50 EGP',
  carrier_name: 'Bosta',
  waybill_number: '7234567',
  order_link: 'https://example.com/track?order=ORD-1042',
  recovery_link: 'https://example.com/checkout',
  coupon_code: '',
  review_link: 'https://example.com/products/linen-shirt#reviews',
  payment_link: 'https://example.com/pay/ORD-1042',
});

function view(key, row) {
  const base = TEMPLATES[key];
  return {
    key,
    event: base.event,
    isEnabled: Boolean(row && row.isEnabled),
    subject: (row && row.subject) || base.subject,
    body: (row && row.body) || base.body,
    isCustomised: Boolean(row && (row.subject || row.body)),
    defaults: { subject: base.subject, body: base.body },
    updatedAt: row ? row.updatedAt : null,
  };
}

const assertKey = (key) => {
  if (!TEMPLATES[key]) throw new NotFoundError('OrderEmailTemplate');
};

async function list(workspaceId) {
  const rows = await db.OrderEmailTemplate.findAll({ where: { workspaceId } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return { templates: KEYS.map((key) => view(key, byKey.get(key))), tokens: context().TOKENS };
}

/** `subject` / `body` null (or equal to the built-in text) go back to the built-in text. */
async function update(workspaceId, key, patch, req) {
  assertKey(key);
  const base = TEMPLATES[key];
  return db.sequelize.transaction(async (transaction) => {
    const [row] = await db.OrderEmailTemplate.findOrCreate({ where: { workspaceId, key }, defaults: { workspaceId, key }, transaction });
    const before = { isEnabled: row.isEnabled, customised: Boolean(row.subject || row.body) };
    const next = {};
    if (patch.isEnabled !== undefined) next.isEnabled = patch.isEnabled;
    if (patch.subject !== undefined) next.subject = patch.subject && patch.subject !== base.subject ? patch.subject : null;
    if (patch.body !== undefined) next.body = patch.body && patch.body !== base.body ? patch.body : null;
    await row.update(next, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order_email.update',
      entityType: 'OrderEmailTemplate',
      entityId: row.id,
      req,
      before,
      after: { key, isEnabled: row.isEnabled, customised: Boolean(row.subject || row.body) },
      transaction,
    });
    return view(key, row);
  });
}

async function brandOf(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'logoUrl', 'themeSettings'] });
  const color = workspace && workspace.themeSettings && /^#[0-9a-f]{6}$/i.test(workspace.themeSettings.primaryColor || '') ? workspace.themeSettings.primaryColor : null;
  return { storeName: workspace ? workspace.name : '', logoUrl: workspace ? workspace.logoUrl : null, color };
}

/** Subject + branded HTML + text for one template and one set of values. */
function compose({ subject, body }, vars, brand) {
  const { render } = context();
  return emailTemplates.render('order_email', {
    subject: render(subject, vars).slice(0, 200),
    body: render(body, vars).slice(0, 10000),
    storeName: brand.storeName,
    logoUrl: brand.logoUrl,
    color: brand.color,
  });
}

/** What the email will look like, with sample values. `draft` previews unsaved text. */
async function preview(workspaceId, key, draft = {}) {
  assertKey(key);
  const row = await db.OrderEmailTemplate.findOne({ where: { workspaceId, key } });
  const current = view(key, row);
  const brand = await brandOf(workspaceId);
  const rendered = compose({ subject: draft.subject || current.subject, body: draft.body || current.body }, { ...SAMPLE_VARS, store_name: brand.storeName }, brand);
  return { subject: rendered.subject, html: rendered.html, text: rendered.text };
}

/** Sends the template with sample values to one address (the teammate's own by default). */
async function sendTest(workspaceId, key, { to, subject, body } = {}, req) {
  assertKey(key);
  const recipient = to || (await db.User.findByPk(req.user.id, { attributes: ['email'] })).email;
  if (!recipient) throw new ValidationError([{ field: 'to', message: 'An email address is required' }], 'Invalid body');
  const row = await db.OrderEmailTemplate.findOne({ where: { workspaceId, key } });
  const current = view(key, row);
  const brand = await brandOf(workspaceId);
  const result = await notify.email({
    recipient,
    template: 'order_email',
    workspaceId,
    data: {
      ...composeData({ subject: subject || current.subject, body: body || current.body }, { ...SAMPLE_VARS, store_name: brand.storeName }, brand),
      // The store's sender name and Reply-To (orderEmailSender.js).
      ...(await require('./orderEmailSender').senderFor(workspaceId)),
    },
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'order_email.test', entityType: 'OrderEmailTemplate', entityId: row ? row.id : null, req, after: { key, ok: result.status === 'sent' } });
  return { ok: result.status === 'sent', error: result.error || null, to: recipient };
}

function composeData({ subject, body }, vars, brand) {
  const { render } = context();
  return { subject: render(subject, vars).slice(0, 200), body: render(body, vars).slice(0, 10000), storeName: brand.storeName, logoUrl: brand.logoUrl, color: brand.color };
}

/**
 * An outbox event happened: send the store's email for it, if that template
 * is switched on and the customer left an email address. Never throws.
 * The merchant's choice on a cancellation or refund wins over the switch:
 * `payload.notifyCustomer` false sends nothing, true sends the template
 * (its built-in text when never customised) even while it is off.
 */
async function handleEvent(workspaceId, eventType, payload = {}) {
  try {
    const keys = KEYS.filter((k) => TEMPLATES[k].event === eventType);
    if (keys.length === 0 || payload.notifyCustomer === false) return [];
    const forced = payload.notifyCustomer === true;
    const stored = await db.OrderEmailTemplate.findAll({ where: { workspaceId, key: keys, ...(forced ? {} : { isEnabled: true }) } });
    const rows = forced ? keys.map((key) => stored.find((r) => r.key === key) || { key }) : stored;
    if (rows.length === 0) return [];
    const subject = payload.orderId
      ? await context().loadOrderSubject(workspaceId, payload.orderId)
      : payload.checkoutSessionId
        ? await context().loadCheckoutSubject(workspaceId, payload.checkoutSessionId)
        : null;
    if (!subject || !subject.email) return [];
    // The abandoned-cart email is marketing: never to a STOP, an unsubscribe or a blocked phone or address,
    // and it ends with an unsubscribe link (marketingUnsubscribe.js).
    let unsubscribeUrl = null;
    if (subject.kind === 'checkout') {
      const refused = await require('../automations/marketingGuard').refusal(workspaceId, subject.phone, subject.email);
      if (refused) {
        logger.info(`[orderEmails] ${eventType} for ${workspaceId} not sent: ${refused}`);
        return [];
      }
      const base = await require('../domains/primaryHost').storeOriginOf(subject.workspace && subject.workspace.slug ? subject.workspace : null);
      unsubscribeUrl = require('./marketingUnsubscribe').linkFor(base, workspaceId, subject.session.id);
    }
    const brand = await brandOf(workspaceId);
    const results = [];
    for (const row of rows) {
      const current = view(row.key, row);
      const sent = await notify.email({
        recipient: subject.email,
        template: 'order_email',
        workspaceId,
        // Listed on the order's timeline (orderTimeline.js).
        orderId: payload.orderId || null,
        data: { ...composeData(current, subject.vars, brand), ...(await require('./orderEmailSender').senderFor(workspaceId)), unsubscribeUrl },
      });
      results.push({ key: row.key, status: sent.status });
    }
    return results;
  } catch (err) {
    logger.error(`[orderEmails] ${eventType} for workspace ${workspaceId} failed: ${err.message}`);
    return [];
  }
}

module.exports = { TEMPLATES, KEYS, EVENTS, list, update, preview, sendTest, handleEvent };
