'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
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
  // Sent when the merchant rejects a transfer and leaves "Tell the customer" ticked (payments/transferResubmit.js).
  transfer_rejected: {
    event: 'order.transfer_rejected',
    subject: 'لم نتمكن من تأكيد التحويل لطلبك {{order_number}}',
    body: 'مرحبًا {{customer_name}}،\n\nلم نتمكن من تأكيد التحويل الخاص بطلبك رقم {{order_number}} من {{store_name}}.\n\nيمكنك رفع إيصال جديد من هنا:\n{{order_link}}',
  },
  // SPEC §18.1: the subscriber gets their portal link. On unless the store turns it off
  // (`defaultOn`): it is the customer's only way to change the card or cancel (subscriptions/subscriptionLinks.js).
  subscription_started: {
    event: 'subscription.created',
    defaultOn: true,
    subject: 'تم تفعيل اشتراكك في {{product_name}}',
    body: 'مرحبًا {{customer_name}}،\n\nشكرًا لاشتراكك في {{product_name}} من {{store_name}} ({{order_total}}).\n\nمن صفحة اشتراكك تقدر تتابعه، تغيّر البطاقة اللي بيتسحب منها، أو تلغيه في أي وقت:\n{{subscription_link}}',
  },
  // Item 372: the answer to a return or exchange the customer asked for. On unless the store turns it
  // off (`defaultOn`): it answers the customer's own request; "Don't tell the customer" skips it.
  return_approved: {
    event: 'return.approved',
    defaultOn: true,
    subject: 'تمت الموافقة على طلب الإرجاع لطلبك {{order_number}}',
    body: 'مرحبًا {{customer_name}}،\n\nوافق {{store_name}} على طلب الإرجاع أو الاستبدال الخاص بطلبك رقم {{order_number}}.\n\nتابع التفاصيل والخطوة التالية من هنا:\n{{order_link}}',
  },
  return_rejected: {
    event: 'return.rejected',
    defaultOn: true,
    subject: 'بخصوص طلب الإرجاع لطلبك {{order_number}}',
    body: 'مرحبًا {{customer_name}}،\n\nللأسف لم يتمكن {{store_name}} من قبول طلب الإرجاع أو الاستبدال الخاص بطلبك رقم {{order_number}}.\n\nتجد السبب والتفاصيل هنا:\n{{order_link}}',
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
  subscription_link: 'https://example.com/subscriptions/3f9a…',
});

// Sample lines for the order table block in previews and tests.
const SAMPLE_LINES = Object.freeze({
  lines: [
    { name: 'قميص كتان أزرق', quantity: 1, total: '600 EGP' },
    { name: 'حزام جلد', quantity: 1, total: '200 EGP' },
  ],
  totals: { shipping: '50 EGP', total: '850 EGP' },
});

function view(key, row) {
  const base = TEMPLATES[key];
  return {
    key,
    event: base.event,
    // A template the store never touched is on only when it is on by default (defaultOn).
    isEnabled: row && row.isEnabled !== undefined ? Boolean(row.isEnabled) : Boolean(base.defaultOn),
    subject: (row && row.subject) || base.subject,
    body: (row && row.body) || base.body,
    isCustomised: Boolean(row && (row.subject || row.body || row.blocks)),
    // The block designer's blocks (emailBlocks.js); null = the plain body is used.
    blocks: row && Array.isArray(row.blocks) && row.blocks.length ? row.blocks : null,
    defaults: { subject: base.subject, body: base.body },
    updatedAt: row ? row.updatedAt : null,
  };
}

const assertKey = (key) => {
  if (!TEMPLATES[key]) throw new NotFoundError('OrderEmailTemplate');
};

/*
 * Per funnel or website (item 175): a template row may belong to the store
 * (scope '') or override it for one funnel ('funnel:<id>') or website
 * ('website:<id>'). An override's empty subject, body or blocks come from the
 * store's version; its on/off is its own. An order uses its funnel's
 * override, else its website's, else the store's.
 */
const scopeKey = (s = {}) => (s && s.funnelId ? `funnel:${s.funnelId}` : s && s.websiteId ? `website:${s.websiteId}` : '');

function merged(storeRow, scopedRow) {
  if (!scopedRow) return storeRow || null;
  const s = storeRow || {};
  return {
    key: scopedRow.key,
    isEnabled: scopedRow.isEnabled,
    subject: scopedRow.subject || s.subject || null,
    body: scopedRow.body || s.body || null,
    // An override's blocks: null = the store's; [] = its own plain subject + body (frontend request).
    blocks: Array.isArray(scopedRow.blocks) ? (scopedRow.blocks.length ? scopedRow.blocks : null) : s.blocks || null,
    updatedAt: scopedRow.updatedAt,
  };
}

async function assertScope(workspaceId, scope = {}) {
  if (scope.funnelId && !(await db.Funnel.findOne({ where: { id: scope.funnelId, workspaceId }, attributes: ['id'] }))) throw new NotFoundError('Funnel');
  if (scope.websiteId && !(await db.Website.findOne({ where: { id: scope.websiteId, workspaceId }, attributes: ['id'] }))) throw new NotFoundError('Website');
}

/** One template in a scope: { current (merged view input), store row, scoped row }. */
async function templateIn(workspaceId, key, scope) {
  const sk = scopeKey(scope);
  const rows = await db.OrderEmailTemplate.findAll({ where: { workspaceId, key, scope: [...new Set(['', sk])] } });
  const storeRow = rows.find((r) => r.scope === '') || null;
  const scopedRow = sk ? rows.find((r) => r.scope === sk) || null : null;
  return { current: view(key, merged(storeRow, scopedRow)), storeRow, scopedRow };
}

async function list(workspaceId, scope = {}) {
  await assertScope(workspaceId, scope);
  const sk = scopeKey(scope);
  const rows = await db.OrderEmailTemplate.findAll({ where: { workspaceId, scope: [...new Set(['', sk])] } });
  const pick = (key, sc) => rows.find((r) => r.key === key && r.scope === sc) || null;
  return {
    scope: sk || null,
    templates: KEYS.map((key) => ({ ...view(key, merged(pick(key, ''), sk ? pick(key, sk) : null)), overridden: Boolean(sk && pick(key, sk)) })),
    tokens: context().TOKENS,
  };
}

/** Removes a funnel's or website's override: that funnel or website uses the store's email again. */
async function removeOverride(workspaceId, key, scope, req) {
  assertKey(key);
  const sk = scopeKey(scope);
  if (!sk) throw new ValidationError([{ field: 'funnelId', message: 'Name the funnel or website whose override to remove' }], 'Invalid query');
  const row = await db.OrderEmailTemplate.findOne({ where: { workspaceId, key, scope: sk } });
  if (!row) throw new NotFoundError('OrderEmailTemplate');
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'order_email.override_remove', entityType: 'OrderEmailTemplate', entityId: row.id, req, after: { key, scope: sk } });
  return (await templateIn(workspaceId, key, {})).current;
}

/** `subject` / `body` null (or equal to the built-in text) go back to the built-in text. */
async function update(workspaceId, key, patch, req, scope = {}) {
  assertKey(key);
  await assertScope(workspaceId, scope);
  const base = TEMPLATES[key];
  const sk = scopeKey(scope);
  // A new override starts from the store's on/off.
  const startOn = sk ? (await templateIn(workspaceId, key, {})).current.isEnabled : Boolean(base.defaultOn);
  return db.sequelize.transaction(async (transaction) => {
    const [row] = await db.OrderEmailTemplate.findOrCreate({ where: { workspaceId, key, scope: sk }, defaults: { workspaceId, key, scope: sk, isEnabled: startOn }, transaction });
    const before = { isEnabled: row.isEnabled, customised: Boolean(row.subject || row.body) };
    const next = {};
    if (patch.isEnabled !== undefined) next.isEnabled = patch.isEnabled;
    if (patch.subject !== undefined) next.subject = patch.subject && patch.subject !== base.subject ? patch.subject : null;
    if (patch.body !== undefined) next.body = patch.body && patch.body !== base.body ? patch.body : null;
    // On an override, `blocks: null` (or []) means its own plain body, kept as [] so the store's blocks do not come back.
    if (patch.blocks !== undefined) next.blocks = patch.blocks && patch.blocks.length ? patch.blocks : sk ? [] : null;
    await row.update(next, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order_email.update',
      entityType: 'OrderEmailTemplate',
      entityId: row.id,
      req,
      before,
      after: { key, scope: sk, isEnabled: row.isEnabled, customised: Boolean(row.subject || row.body) },
      transaction,
    });
    if (!sk) return view(key, row);
    const storeRow = await db.OrderEmailTemplate.findOne({ where: { workspaceId, key, scope: '' }, transaction });
    return { ...view(key, merged(storeRow, row)), overridden: true };
  });
}

async function brandOf(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'logoUrl', 'themeSettings'] });
  const color = workspace && workspace.themeSettings && /^#[0-9a-f]{6}$/i.test(workspace.themeSettings.primaryColor || '') ? workspace.themeSettings.primaryColor : null;
  return { storeName: workspace ? workspace.name : '', logoUrl: workspace ? workspace.logoUrl : null, color };
}

/** What the email will look like, with sample values. `draft` previews unsaved text. */
async function preview(workspaceId, key, draft = {}, scope = {}) {
  assertKey(key);
  const { current } = await templateIn(workspaceId, key, scope);
  const brand = await brandOf(workspaceId);
  const blocks = draft.blocks !== undefined ? draft.blocks : current.blocks;
  const data = composeData({ subject: draft.subject || current.subject, body: draft.body || current.body, blocks }, { ...SAMPLE_VARS, store_name: brand.storeName }, brand, SAMPLE_LINES);
  const rendered = emailTemplates.render('order_email', data);
  return { subject: rendered.subject, html: rendered.html, text: rendered.text };
}

/** Sends the template with sample values to one address (the teammate's own by default). */
const TEST_SENDS_PER_DAY = 50;

async function sendTest(workspaceId, key, { to, subject, body, blocks } = {}, req, scope = {}) {
  assertKey(key);
  const own = (await db.User.findByPk(req.user.id, { attributes: ['email'] })).email;
  const recipient = to || own;
  if (!recipient) throw new ValidationError([{ field: 'to', message: 'An email address is required' }], 'Invalid body');
  // A test goes to the team only (item 298): the signed-in user or an active member of this store. Any
  // address with free text would make the platform's mail a phishing sender.
  if (String(recipient).toLowerCase() !== String(own || '').toLowerCase()) {
    const member = await db.Membership.count({
      where: { workspaceId, status: 'active' },
      include: [{ model: db.User, as: 'user', attributes: [], where: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('user.email')), String(recipient).toLowerCase()) }],
    });
    if (!member) throw new ValidationError([{ field: 'to', message: 'Test emails go to you or a member of this store\'s team' }], 'Invalid body');
  }
  // And at most TEST_SENDS_PER_DAY a day per store.
  const sentToday = await db.AuditLog.count({ where: { workspaceId, action: 'order_email.test', createdAt: { [db.Sequelize.Op.gt]: new Date(Date.now() - 86400000) } } });
  if (sentToday >= TEST_SENDS_PER_DAY) throw new AppError('TOO_MANY_TEST_EMAILS', `At most ${TEST_SENDS_PER_DAY} test emails a day`, 429);
  const { current, scopedRow, storeRow } = await templateIn(workspaceId, key, scope);
  const row = scopedRow || storeRow;
  const brand = await brandOf(workspaceId);
  const result = await notify.email({
    recipient,
    template: 'order_email',
    workspaceId,
    data: {
      ...composeData({ subject: subject || current.subject, body: body || current.body, blocks: blocks !== undefined ? blocks : current.blocks }, { ...SAMPLE_VARS, store_name: brand.storeName }, brand, SAMPLE_LINES),
      // The store's sender name and Reply-To (orderEmailSender.js).
      ...(await require('./orderEmailSender').senderFor(workspaceId)),
    },
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'order_email.test', entityType: 'OrderEmailTemplate', entityId: row ? row.id : null, req, after: { key, ok: result.status === 'sent' } });
  return { ok: result.status === 'sent', error: result.error || null, to: recipient };
}

function composeData({ subject, body, blocks }, vars, brand, table = null) {
  const { render } = context();
  const data = { subject: render(subject, vars).slice(0, 200), body: render(body, vars).slice(0, 10000), storeName: brand.storeName, logoUrl: brand.logoUrl, color: brand.color };
  if (!blocks || !blocks.length) return data;
  // The block designer: rendered and escaped here, from the JSON (emailBlocks.js).
  const out = require('./emailBlocks').renderBlocks(blocks, { fill: (t) => render(String(t || ''), vars), color: brand.color || undefined, ...(table || {}) });
  return { ...data, bodyHtml: out.html, bodyText: out.text };
}

/** The order's (or cart's) lines for the order table block. */
function tableOf(subject) {
  const { formatAmount } = context();
  if (subject.kind === 'order' && subject.order) {
    const o = subject.order;
    return {
      lines: (o.items || []).map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity, total: formatAmount(i.lineTotalAmount, o.currency) })),
      totals: { shipping: Number(o.shippingAmount) ? formatAmount(o.shippingAmount, o.currency) : null, total: formatAmount(o.totalAmount, o.currency) },
    };
  }
  if (subject.kind === 'checkout' && subject.session) {
    const s = subject.session;
    const items = Array.isArray(s.items) ? s.items : [];
    return { lines: items.map((i) => ({ name: i.productName || '', quantity: i.quantity, total: formatAmount(i.lineTotalAmount, s.currency) })), totals: { total: formatAmount(s.subtotalAmount, s.currency) } };
  }
  return null;
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
    const stored = await db.OrderEmailTemplate.findAll({ where: { workspaceId, key: keys } });
    // Nothing can be on anywhere (no row on, none on by default): nothing to load.
    if (!forced && !stored.some((r) => r.isEnabled) && !keys.some((k) => TEMPLATES[k].defaultOn)) return [];
    // A subscription event speaks about the subscription (its product, amount and page), not the order that started it.
    const subject = payload.subscriptionId
      ? await context().loadSubscriptionSubject(workspaceId, payload.subscriptionId)
      : payload.orderId
      ? await context().loadOrderSubject(workspaceId, payload.orderId)
      : payload.checkoutSessionId
        ? await context().loadCheckoutSubject(workspaceId, payload.checkoutSessionId)
        : null;
    if (!subject || !subject.email) return [];
    // The funnel's override, else the website's, else the store's (item 175).
    const origin = subject.order
      ? { funnelId: subject.order.funnelId, websiteId: subject.order.websiteId }
      : subject.session
        ? { funnelId: (subject.session.attribution || {}).funnelId, websiteId: (subject.session.attribution || {}).websiteId }
        : {};
    const scopes = [origin.funnelId && `funnel:${origin.funnelId}`, origin.websiteId && `website:${origin.websiteId}`].filter(Boolean);
    // Forced: every template of the event. Otherwise the ones switched on — or never touched and on by default.
    const rows = keys
      .map((key) => {
        const storeRow = stored.find((r) => r.key === key && r.scope === '') || null;
        const scopedRow = scopes.map((sc) => stored.find((r) => r.key === key && r.scope === sc)).find(Boolean) || null;
        const row = merged(storeRow, scopedRow);
        if (forced) return row || { key };
        if (row) return row.isEnabled ? row : null;
        return TEMPLATES[key].defaultOn ? { key } : null;
      })
      .filter(Boolean);
    if (rows.length === 0) return [];
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
        data: { ...composeData(current, subject.vars, brand, tableOf(subject)), ...(await require('./orderEmailSender').senderFor(workspaceId)), unsubscribeUrl },
      });
      results.push({ key: row.key, status: sent.status });
    }
    return results;
  } catch (err) {
    logger.error(`[orderEmails] ${eventType} for workspace ${workspaceId} failed: ${err.message}`);
    return [];
  }
}

module.exports = { TEMPLATES, KEYS, EVENTS, list, update, removeOverride, preview, sendTest, handleEvent, scopeKey };
