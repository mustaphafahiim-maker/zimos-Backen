'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const secretBox = require('../../core/utils/secretBox');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const readyMade = require('../automations/automationTemplates');

/**
 * "Create on WhatsApp" for a ready-made automation (spec-gaps item 391, SPEC
 * §14.2 / §14.1): ZIMOS submits the automation's message templates to the
 * store's own WhatsApp Business account (POST /{waba-id}/message_templates,
 * whatsappCloud.createTemplate) instead of the merchant typing them into
 * WhatsApp Manager by hand.
 *
 *   POST /workspaces/:id/automations/templates/:key/whatsapp
 *        { activateWhenApproved = true, locale, couponCode, languages? }
 *   GET  /workspaces/:id/automations/templates/:key/whatsapp
 *
 * What a submit does, in one transaction (locked per store and automation):
 *   - the ready-made automation's rule: the store's existing one, else a new
 *     one made from it (as POST …/templates/:key/enable would) but OFF;
 *   - every WhatsApp template that rule's steps send, in the step's language
 *     (Arabic) plus English when the store offers English (item 383) or the
 *     merchant names `languages`: a (name, language) the store already has a
 *     row for is linked, not sent again (so a second submit creates nothing);
 *     a new one is submitted with the body, its {{n}} examples and the quick
 *     reply buttons, and stored as Meta answered (PENDING, usually); when Meta
 *     says the name is taken in that language, the existing template is
 *     fetched and stored instead (`reused`);
 *   - the rule stays off until every template its steps send is APPROVED.
 *     With `activateWhenApproved` the rule is marked to switch itself on then;
 *     a rule that was on is paused until then (it would only fail meanwhile).
 *     Already approved: the rule is (or stays) on at once.
 * Meta's error (rate limit, refused content, bad token) rolls the whole
 * submit back; templates Meta did create before it are picked up by the
 * next submit through the "name taken" path.
 *
 * After the status webhook or a sync changes a template (whatsappTemplates.js
 * calls reconcile): a rule waiting for approval turns on once its templates
 * are all APPROVED (audited, with a bell), and a submitted template that Meta
 * REJECTED rings the bell once with Meta's reason.
 */

const PROVIDER = 'whatsapp_cloud';
const NOTIFY_TYPE = 'whatsapp.template';

// The English versions of the ready-made templates (automationTemplates.js holds the Arabic).
const ENGLISH = {
  order_confirmation: { body: 'Hi {{1}}, we received your order {{2}} for {{3}}. Please confirm it so we can start preparing it.', buttons: ['Confirm order', 'Cancel'] },
  order_shipped: { body: 'Hi {{1}}, your order {{2}} has shipped. Waybill number: {{3}}. Track it here: {{4}}' },
  out_for_delivery: { body: 'Hi {{1}}, the courier is on the way with your order {{2}}. Please have {{3}} ready.' },
  order_delivered: { body: 'Hi {{1}}, we are glad your order arrived. Thank you for shopping with {{2}}.' },
  review_request: { body: 'Hi {{1}}, we hope you liked {{2}}. Your opinion matters to us: {{3}}' },
  cart_reminder: { body: 'Hi {{1}}, your order from {{2}} is waiting for you. Complete it here: {{3}}\nTo stop these messages, reply: STOP' },
  cart_reminder_last: { body: 'Hi {{1}}, your order is still saved. Complete it now: {{2}}\nTo stop these messages, reply: STOP' },
  cart_reminder_coupon: { body: 'Hi {{1}}, your order is still saved. Use the code {{2}} for a discount. Complete it now: {{3}}\nTo stop these messages, reply: STOP' },
  payment_failed: { body: 'Hi {{1}}, the payment for your order {{2}} did not go through. Try again here: {{3}}' },
  transfer_rejected: { body: 'Hi {{1}}, we could not confirm the transfer for your order {{2}}. Upload a new receipt here: {{3}}' },
  digital_delivery: { body: 'Hi {{1}}, thank you for your order {{2}}. Your digital purchases are ready to download here: {{3}}' },
  tried_to_reach: { body: 'Hi {{1}}, we tried to reach you to confirm your order {{2}} from {{3}} but could not. Please reply to this message to confirm your order.' },
  subscription_renewal_failed: { body: 'Hi {{1}}, we could not charge the renewal of your {{2}} subscription. Update your card here to keep it going: {{3}}' },
  subscription_started: { body: 'Hi {{1}}, your {{2}} subscription is active. Follow it, change your card or cancel it here: {{3}}' },
};

// Meta refuses a body that starts or ends with a variable: one that ends on a link gets a closing line.
const CLOSING = { ar: 'شكرًا لك.', en: 'Thank you.' };

// The sample value Meta's reviewers see for each automation token (example.body_text).
const LINK = 'https://shop.example.com/o/a1b2c3';
const SAMPLES = {
  customer_name: { ar: 'أحمد', en: 'Ahmed' },
  order_number: '1001',
  order_total: { ar: '٢٥٠ جنيه', en: 'EGP 250' },
  waybill_number: '7400123456',
  store_name: { ar: 'متجر النور', en: 'Nour Store' },
  product_names: { ar: 'قميص قطن', en: 'Cotton shirt' },
  product_name: { ar: 'باقة القهوة الشهرية', en: 'Monthly coffee box' },
  coupon_code: 'WELCOME10',
  order_link: LINK,
  review_link: LINK,
  recovery_link: LINK,
  payment_link: LINK,
  subscription_link: LINK,
  confirm_link: LINK,
};

const baseLang = (l) => String(l || '').toLowerCase().split(/[-_]/)[0];

function sampleFor(param, lang) {
  const token = (String(param).match(/\{\{\s*([a-z_]+)\s*\}\}/) || [])[1];
  const s = token && SAMPLES[token];
  if (!s) return String(param).replace(/\{\{[^}]*\}\}/g, '').trim() || 'example';
  return typeof s === 'string' ? s : s[lang === 'en' ? 'en' : 'ar'];
}

function withClosing(body, lang) {
  return /\{\{\s*\d+\s*\}\}\s*$/.test(body) ? `${body}\n${CLOSING[lang === 'en' ? 'en' : 'ar']}` : body;
}

/** name → the ready-made template's Arabic definition { name, body, buttons }. */
function definitionsOf(t) {
  return new Map([t.whatsapp, ...(t.whatsappExtra || [])].filter(Boolean).map((w) => [w.name, w]));
}

/** The (name, language, params) a rule's steps send, for the templates this automation defines. */
function neededOf(steps, defs) {
  const out = [];
  for (const s of steps || []) {
    if (!s || s.type !== 'whatsapp_template' || !defs.has(s.template)) continue;
    const language = s.language || 'ar';
    if (!out.some((n) => n.name === s.template && n.language === language)) out.push({ name: s.template, language, params: s.params || [] });
  }
  return out;
}

/** What goes to Meta for one name in one language. */
function contentFor(t, def, language, params) {
  const lang = baseLang(language);
  const words = lang === 'en' ? ENGLISH[def.name] : def;
  if (!words) throw new AppError('WHATSAPP_TEMPLATE_LANGUAGE_UNSUPPORTED', `There is no ${language} text for the template "${def.name}"`, 422);
  const body = withClosing(words.body, lang);
  return {
    name: def.name,
    language,
    category: t.key === 'abandoned_cart' ? 'MARKETING' : 'UTILITY',
    body,
    buttons: words.buttons || [],
    examples: params.map((p) => sampleFor(p, lang)),
  };
}

// ------------------------------------------------------------------ Meta --

async function connectedIntegration(workspaceId) {
  const integration = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER } });
  if (!integration || integration.status !== 'connected') throw new AppError('WHATSAPP_NOT_CONNECTED', 'Connect WhatsApp in Settings → Integrations first', 422);
  return integration;
}

/** createTemplate / findTemplates bound to this store's account (the sandbox number answers locally). */
function accountOf(integration) {
  const cfg = integration.config || {};
  const sandbox = require('./whatsappSandbox');
  const client = sandbox.isSandbox(cfg.phoneNumberId) ? sandbox : require('./whatsappCloud');
  if (!sandbox.isSandbox(cfg.phoneNumberId) && !cfg.businessAccountId) {
    throw new AppError('WHATSAPP_NO_BUSINESS_ACCOUNT', 'Add your WhatsApp Business Account ID in the WhatsApp settings to create templates', 422);
  }
  const token = () => JSON.parse(secretBox.open(integration.secretsSealed) || '{}').accessToken;
  return {
    create: (c) => client.createTemplate({ wabaId: cfg.businessAccountId, token: token(), name: c.name, language: c.language, category: c.category, components: c.components }),
    find: (name) => client.findTemplates(cfg.businessAccountId, token(), name),
  };
}

const bodyOf = (components) => ((components || []).find((c) => String(c.type).toUpperCase() === 'BODY') || {}).text || null;

/** Links the store's row for (name, language), or submits it to Meta and stores what Meta answered. */
async function ensureTemplate(workspaceId, account, content, link, transaction) {
  const { paramsCountOf } = require('./whatsappTemplates');
  const now = new Date();
  const existing = await db.WhatsappTemplate.findOne({ where: { workspaceId, name: content.name, language: content.language }, transaction });
  if (existing) {
    await existing.update({ automationRuleId: link.ruleId, submittedAt: existing.submittedAt || now, submittedBy: existing.submittedBy || link.userId }, { transaction });
    return { row: existing, outcome: 'existing' };
  }
  const components = require('./whatsappCloud').buildComponents(content);
  const fields = { workspaceId, syncedAt: now, automationRuleId: link.ruleId, submittedAt: now, submittedBy: link.userId };
  try {
    const made = await account.create({ ...content, components });
    const row = await db.WhatsappTemplate.create(
      { ...fields, metaId: made.id, name: content.name, language: content.language, category: made.category || content.category, status: made.status, bodyText: content.body, paramsCount: paramsCountOf(content.body), components },
      { transaction }
    );
    return { row, outcome: 'submitted' };
  } catch (err) {
    if (err.code !== 'WHATSAPP_TEMPLATE_NAME_TAKEN' || !(err.details && err.details.reusable)) throw err;
    // Already in the account under this name and language (made by hand, or by a submit that was rolled back): use it.
    const found = (await account.find(content.name)).find((t) => String(t.language) === content.language);
    if (!found) throw err;
    const body = bodyOf(found.components);
    const row = await db.WhatsappTemplate.create(
      {
        ...fields,
        metaId: found.id ? String(found.id) : null,
        name: content.name,
        language: content.language,
        category: found.category || null,
        status: String(found.status || 'PENDING').toUpperCase(),
        rejectedReason: found.rejected_reason && found.rejected_reason !== 'NONE' ? String(found.rejected_reason).slice(0, 200) : null,
        bodyText: body,
        paramsCount: paramsCountOf(body),
        components: found.components || null,
      },
      { transaction }
    );
    return { row, outcome: 'reused' };
  }
}

// ---------------------------------------------------------------- submit --

const ruleView = (r) => (r ? { id: r.id, name: r.name, isActive: r.isActive, templateKey: r.templateKey } : null);

/** pending | approved | rejected over the templates the rule's steps send. */
function stateOf(rows) {
  if (!rows.length) return null;
  if (rows.some((r) => r.status === 'REJECTED' || r.status === 'DISABLED')) return 'rejected';
  if (rows.every((r) => r.status === 'APPROVED')) return 'approved';
  return 'pending';
}

const rowView = (r, outcome) => ({
  id: r.id,
  name: r.name,
  language: r.language,
  category: r.category,
  status: r.status,
  rejectedReason: r.rejectedReason,
  bodyText: r.bodyText,
  submittedAt: r.submittedAt,
  ...(outcome ? { outcome } : {}),
});

/** The rule's required rows: its steps' (template, language) among the templates linked to it. */
function requiredRows(rule, linked) {
  const steps = (rule.actions || []).filter((s) => s && s.type === 'whatsapp_template');
  return linked.filter((r) => steps.some((s) => s.template === r.name && (s.language || 'ar') === r.language));
}

async function submit(workspaceId, key, { locale = 'ar', couponCode = null, activateWhenApproved = true, languages = null } = {}, req) {
  const t = readyMade.byKey(key);
  if (!t) throw new NotFoundError('AutomationTemplate');
  const defs = definitionsOf(t);
  if (!defs.size) throw new AppError('AUTOMATION_HAS_NO_WHATSAPP', 'This automation sends no WhatsApp message', 422);
  await require('../apps/appGate').assertEnabled(workspaceId, 'whatsapp');
  const account = accountOf(await connectedIntegration(workspaceId));
  const workspace = await require('../orders/orderLocale').loadWorkspace(workspaceId);
  // English too when the store offers it (item 383), unless the merchant named the languages.
  const extra = languages || (require('../translations/translations').languagesOf(workspace || {}).languages.includes('en') ? ['en'] : []);
  const userId = req.user.id;

  const result = await db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `wa-template-submit:${workspaceId}:${key}` }, transaction });
    let rule = await db.AutomationRule.findOne({ where: { workspaceId, templateKey: key }, transaction, lock: transaction.LOCK.UPDATE });
    const created = !rule;
    if (!rule) {
      const made = readyMade.ruleFrom(t, couponCode);
      rule = await db.AutomationRule.create(
        { workspaceId, name: t.name[locale === 'en' ? 'en' : 'ar'], trigger: t.trigger, conditions: made.conditions, actions: made.steps, isActive: false, templateKey: key },
        { transaction }
      );
    }
    const needed = neededOf(rule.actions, defs);
    if (!needed.length) throw new AppError('AUTOMATION_HAS_NO_WHATSAPP', 'This automation no longer has a WhatsApp step with one of its templates', 422);

    const link = { ruleId: rule.id, userId };
    const done = [];
    for (const n of needed) {
      const langs = [n.language, ...extra.filter((l) => baseLang(l) !== baseLang(n.language))];
      for (const language of langs) {
        if (done.some((d) => d.row.name === n.name && d.row.language === language)) continue;
        const content = contentFor(t, defs.get(n.name), language, n.params);
        done.push(await ensureTemplate(workspaceId, account, content, link, transaction));
      }
    }

    const required = needed.map((n) => done.find((d) => d.row.name === n.name && d.row.language === n.language).row);
    const approved = required.every((r) => r.status === 'APPROVED');
    const before = ruleView(rule);
    const isActive = approved ? (created ? activateWhenApproved : rule.isActive || activateWhenApproved) : false;
    const waiting = !approved && activateWhenApproved;
    if (rule.isActive !== isActive) await rule.update({ isActive }, { transaction });
    await db.WhatsappTemplate.update({ activateRule: waiting }, { where: { workspaceId, automationRuleId: rule.id }, transaction });

    if (created) {
      await recordAudit({ workspaceId, actorUserId: userId, action: 'automation.create', entityType: 'AutomationRule', entityId: rule.id, after: ruleView(rule), metadata: { templateKey: key, via: 'whatsapp_template_submit' }, req, transaction });
    } else if (before.isActive !== rule.isActive) {
      await recordAudit({ workspaceId, actorUserId: userId, action: 'automation.update', entityType: 'AutomationRule', entityId: rule.id, before, after: ruleView(rule), metadata: { templateKey: key, reason: rule.isActive ? 'whatsapp_templates_approved' : 'waiting_for_whatsapp_approval' }, req, transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: 'whatsapp.template.submit',
      entityType: 'AutomationRule',
      entityId: rule.id,
      metadata: { templateKey: key, activateWhenApproved, templates: done.map((d) => ({ id: d.row.id, name: d.row.name, language: d.row.language, status: d.row.status, outcome: d.outcome })) },
      req,
      transaction,
    });
    return {
      templateKey: key,
      status: stateOf(required),
      rule: { ...ruleView(rule), activateWhenApproved: waiting },
      ruleCreated: created,
      templates: done.map((d) => rowView(d.row, d.outcome)),
    };
  });
  // A status webhook Meta sent before the commit found no row: read the new templates back once.
  const refreshed = await refreshSubmitted(workspaceId, account, result.templates).catch((err) => {
    logger.warn(`[whatsapp] template read-back for ${workspaceId} failed: ${err.message}`);
    return false;
  });
  // A template Meta rejected on the spot rings the bell now.
  await reconcile(workspaceId);
  if (refreshed) {
    // The answer says where things stand now (a rule may have just switched itself on).
    const now = await status(workspaceId, key);
    result.status = now.status;
    if (now.rule) result.rule = { ...result.rule, isActive: now.rule.isActive, activateWhenApproved: now.rule.activateWhenApproved };
  }
  return result;
}

/**
 * The templates this submit created at Meta, read back after the commit. A
 * row still at the status stored at submit takes Meta's current one (a
 * webhook applied since then is newer and is left alone). Best effort;
 * true when a row changed.
 */
async function refreshSubmitted(workspaceId, account, templates) {
  let changed = false;
  const submitted = templates.filter((t) => t.outcome === 'submitted');
  for (const name of new Set(submitted.map((t) => t.name))) {
    let found;
    try {
      found = await account.find(name);
    } catch (err) {
      logger.warn(`[whatsapp] could not read back template ${name} for ${workspaceId}: ${err.message}`);
      continue;
    }
    for (const t of submitted.filter((x) => x.name === name)) {
      const meta = (Array.isArray(found) ? found : []).find((f) => f && String(f.language) === t.language);
      const metaStatus = meta && meta.status ? String(meta.status).toUpperCase() : null;
      if (!metaStatus || metaStatus === t.status) continue;
      const rejectedReason = meta.rejected_reason && meta.rejected_reason !== 'NONE' ? String(meta.rejected_reason).slice(0, 200) : null;
      const [n] = await db.WhatsappTemplate.update({ status: metaStatus, rejectedReason, syncedAt: new Date() }, { where: { id: t.id, status: t.status } });
      if (n) {
        Object.assign(t, { status: metaStatus, rejectedReason });
        changed = true;
      }
    }
  }
  return changed;
}

/** Where a ready-made automation's WhatsApp templates stand. */
async function status(workspaceId, key) {
  const t = readyMade.byKey(key);
  if (!t) throw new NotFoundError('AutomationTemplate');
  const rule = await db.AutomationRule.findOne({ where: { workspaceId, templateKey: key } });
  const defs = definitionsOf(t);
  const needed = neededOf(rule ? rule.actions : readyMade.ruleFrom(t).steps, defs);
  const rows = await db.WhatsappTemplate.findAll({ where: { workspaceId, name: [...new Set(needed.map((n) => n.name))] }, order: [['name', 'ASC'], ['language', 'ASC']] });
  const required = needed.map((n) => rows.find((r) => r.name === n.name && r.language === n.language)).filter(Boolean);
  return {
    templateKey: key,
    // null: not submitted yet (nothing in the account under these names).
    status: required.length === needed.length ? stateOf(required) : required.length ? 'incomplete' : null,
    rule: rule ? { ...ruleView(rule), activateWhenApproved: rows.some((r) => r.automationRuleId === rule.id && r.activateRule) } : null,
    templates: rows.map((r) => rowView(r)),
  };
}

// ------------------------------------------------------------- reconcile --

// Meta's rejection reasons, in the merchant's words.
const REASONS = {
  INVALID_FORMAT: { ar: 'صيغة القالب غير صحيحة', en: 'the template is not formatted correctly' },
  TAG_CONTENT_MISMATCH: { ar: 'المحتوى لا يطابق الفئة المختارة', en: 'the content does not match its category' },
  INCORRECT_CATEGORY: { ar: 'الفئة المختارة غير مناسبة للمحتوى', en: 'the category does not fit the content' },
  PROMOTIONAL: { ar: 'المحتوى ترويجي', en: 'the content is promotional' },
  ABUSIVE_CONTENT: { ar: 'المحتوى مخالف لسياسات واتساب', en: 'the content breaks WhatsApp policies' },
  SCAM: { ar: 'المحتوى يشبه الاحتيال', en: 'the content looks like a scam' },
};

async function notifyRejected(workspaceId, row) {
  const rule = row.automationRuleId ? await db.AutomationRule.findByPk(row.automationRuleId, { attributes: ['id', 'name'] }) : null;
  const reason = row.rejectedReason || null;
  const said = (lang) => (reason ? `${reason}${REASONS[reason] ? ` (${REASONS[reason][lang]})` : ''}` : lang === 'ar' ? 'لم تذكر Meta سببًا' : 'Meta gave no reason');
  const ar = {
    title: `رفضت واتساب قالب «${row.name}» (${row.language})`,
    body: `سبب Meta: ${said('ar')}. عدّل القالب في WhatsApp Manager ثم زامن القوالب${rule ? `؛ أتمتة «${rule.name}» متوقفة حتى تتم الموافقة` : ''}.`,
  };
  const en = {
    title: `WhatsApp rejected the template "${row.name}" (${row.language})`,
    body: `Meta's reason: ${said('en')}. Edit the template in WhatsApp Manager, then sync templates${rule ? `; the automation "${rule.name}" stays off until it is approved` : ''}.`,
  };
  await require('../notifications/merchantNotificationService').create(workspaceId, {
    type: NOTIFY_TYPE,
    ...ar,
    localized: { ar, en },
    link: '/automations',
    data: { event: 'rejected', templateId: row.id, name: row.name, language: row.language, reason, ruleId: rule ? rule.id : null },
    dedupeKey: `wa-template-rejected:${row.id}:${row.rejectionNotifiedAt ? new Date(row.rejectionNotifiedAt).getTime() : ''}`,
  });
}

async function activateIfReady(workspaceId, ruleId) {
  return db.sequelize.transaction(async (transaction) => {
    const rule = await db.AutomationRule.findOne({ where: { id: ruleId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const clear = () => db.WhatsappTemplate.update({ activateRule: false }, { where: { workspaceId, automationRuleId: ruleId }, transaction });
    if (!rule || rule.isActive) return clear();
    const linked = await db.WhatsappTemplate.findAll({ where: { workspaceId, automationRuleId: ruleId }, transaction });
    if (!linked.some((r) => r.activateRule)) return null;
    const required = requiredRows(rule, linked);
    if (!required.length || !required.every((r) => r.status === 'APPROVED')) return null;
    const before = ruleView(rule);
    await rule.update({ isActive: true }, { transaction });
    await clear();
    await recordAudit({
      workspaceId,
      action: 'automation.update',
      entityType: 'AutomationRule',
      entityId: rule.id,
      before,
      after: ruleView(rule),
      metadata: { reason: 'whatsapp_templates_approved', templates: required.map((r) => ({ name: r.name, language: r.language })) },
      transaction,
    });
    const ar = { title: `تمت الموافقة على قوالب واتساب — «${rule.name}» تعمل الآن`, body: 'وافقت Meta على قوالب هذه الأتمتة فتم تشغيلها تلقائيًا كما طلبت.' };
    const en = { title: `WhatsApp templates approved — "${rule.name}" is on`, body: 'Meta approved this automation\'s templates, so it was switched on as you asked.' };
    transaction.afterCommit(() =>
      require('../notifications/merchantNotificationService').create(workspaceId, {
        type: NOTIFY_TYPE,
        ...ar,
        localized: { ar, en },
        link: '/automations',
        data: { event: 'activated', ruleId: rule.id, templateKey: rule.templateKey },
        dedupeKey: `wa-template-activated:${rule.id}:${Date.now()}`,
      })
    );
    return rule;
  });
}

/**
 * After template statuses changed (status webhook, sync, submit): rejections
 * of submitted templates ring the bell once, and rules waiting for approval
 * turn on when theirs are approved. Never throws.
 */
async function reconcile(workspaceId) {
  try {
    const rejected = await db.WhatsappTemplate.findAll({ where: { workspaceId, automationRuleId: { [Op.ne]: null }, status: 'REJECTED', rejectionNotifiedAt: null } });
    for (const row of rejected) {
      const at = new Date();
      // Claimed first: the webhook and a sync racing tell the merchant once.
      const [claimed] = await db.WhatsappTemplate.update({ rejectionNotifiedAt: at }, { where: { id: row.id, rejectionNotifiedAt: null } });
      if (!claimed) continue;
      row.rejectionNotifiedAt = at;
      await notifyRejected(workspaceId, row);
    }
    // No longer rejected (edited and approved, or appealed): a later rejection is told again.
    await db.WhatsappTemplate.update({ rejectionNotifiedAt: null }, { where: { workspaceId, status: { [Op.ne]: 'REJECTED' }, rejectionNotifiedAt: { [Op.ne]: null } } });

    const waiting = await db.WhatsappTemplate.findAll({ where: { workspaceId, activateRule: true, automationRuleId: { [Op.ne]: null } }, attributes: ['automationRuleId'] });
    for (const ruleId of new Set(waiting.map((r) => r.automationRuleId))) await activateIfReady(workspaceId, ruleId);
  } catch (err) {
    logger.warn(`[whatsapp] template reconcile for ${workspaceId} failed: ${err.message}`);
  }
}

/** The merchant switched the rule on or off by hand: an approval no longer switches it. */
function forgetActivation(workspaceId, ruleId) {
  return db.WhatsappTemplate.update({ activateRule: false }, { where: { workspaceId, automationRuleId: ruleId, activateRule: true } });
}

// ---------------------------------------------------------------- routes --
// Mounted on the automations router (automationRoutes.js), after authenticate,
// resolveTenant and requirePermission(AUTOMATIONS_MANAGE).

const router = Router({ mergeParams: true });
const params = Joi.object({ workspaceId: Joi.string().uuid().required(), key: Joi.string().max(60).required() });

router.get(
  '/templates/:key/whatsapp',
  validate({ params }),
  asyncHandler(async (req, res) => res.json(await status(req.tenant.workspaceId, req.params.key)))
);
router.post(
  '/templates/:key/whatsapp',
  validate({
    params,
    body: Joi.object({
      // Switch the rule on by itself once Meta approves its templates.
      activateWhenApproved: Joi.boolean().default(true),
      // For a rule made by this call: its name's language and the coupon (as …/enable takes them).
      locale: Joi.string().valid('ar', 'en').default('ar'),
      couponCode: Joi.string().trim().max(100).allow(null, '').optional(),
      // Extra languages besides each step's own; default: English when the store offers it.
      languages: Joi.array().items(Joi.string().valid('ar', 'en')).max(2).unique().optional(),
    }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const out = await submit(req.tenant.workspaceId, req.params.key, req.body, req);
    res.status(out.templates.some((t) => t.outcome !== 'existing') || out.ruleCreated ? 201 : 200).json(out);
  })
);

module.exports = { submit, status, reconcile, forgetActivation, router, ENGLISH };
