'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const queue = require('../../core/queue');
const logger = require('../../core/utils/logger');
const { normalizePhone } = require('../../core/utils/phone');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * WhatsApp campaigns (SPEC §14.4): one approved marketing template sent to
 * contacts who agreed to marketing — and only to them.
 *
 * Audience: every consenting contact, a segment (modules/contacts), or an
 * uploaded list of names and numbers. Whatever the source, a person is only
 * messaged when a contact with that number exists in the store *and* has
 * `marketingConsent`; everyone else is counted as excluded and never stored
 * as a recipient. Blocked customers are excluded too.
 *
 * Pace: the recipients are fixed when the campaign starts, then sent in
 * small batches by the `whatsapp.campaign_tick` job, never more than
 * `dailyCap` a day (to protect the number's quality rating). The campaign
 * pauses itself when most of a batch fails — the closest signal available
 * here to "the number's rating dropped".
 *
 * Opting out: a customer who replies STOP (or its Arabic forms) loses
 * `marketingConsent` at once and is skipped by every campaign still sending.
 */

const TICK_JOB = 'whatsapp.campaign_tick';
const BATCH = 20;
const TICK_GAP_MS = 5000;
const MAX_LIST_ROWS = 5000;
const REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ORDER_WINDOW_DAYS = 7;

const normalise = (text) =>
  String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[.!؟?]+$/g, '')
    .replace(/\s+/g, ' ');
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'الغاء', 'الغاء الاشتراك', 'ايقاف', 'توقف', 'لا ترسل'].map(normalise));

const view = (c, report) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  audience: { type: c.audience.type || 'all', segmentId: c.audience.segmentId || null, listSize: Array.isArray(c.audience.rows) ? c.audience.rows.length : null },
  template: { name: c.templateName, language: c.templateLanguage, params: c.templateParams || [] },
  couponCode: c.couponCode,
  dailyCap: c.dailyCap,
  scheduledAt: c.scheduledAt,
  startedAt: c.startedAt,
  completedAt: c.completedAt,
  pauseReason: c.pauseReason,
  audienceSize: c.audienceSize,
  excludedNoConsent: c.excludedNoConsent,
  createdAt: c.createdAt,
  ...(report ? { report } : {}),
});

async function find(workspaceId, campaignId, options = {}) {
  const campaign = await db.WhatsappCampaign.findOne({ where: { id: campaignId, workspaceId }, ...options });
  if (!campaign) throw new NotFoundError('Campaign');
  return campaign;
}

// ----------------------------------------------------------------- audience --

/**
 * Who a campaign would reach: { recipients: [{ customerId, phoneNormalized, name }], audienceSize, excluded }.
 * `excluded` = people in the audience who cannot be messaged (no consent, blocked, unknown number).
 */
async function resolveAudience(workspaceId, audience) {
  const type = (audience && audience.type) || 'all';
  let candidates = []; // { id, fullName, phoneNormalized, marketingConsent, isBlacklisted }
  let audienceSize = 0;

  if (type === 'list') {
    const byPhone = new Map();
    for (const row of (audience.rows || []).slice(0, MAX_LIST_ROWS)) {
      const phone = normalizePhone(row.phone);
      if (phone && !byPhone.has(phone)) byPhone.set(phone, row.name || null);
    }
    audienceSize = byPhone.size;
    if (byPhone.size) {
      const customers = await db.Customer.findAll({
        where: { workspaceId, phoneNormalized: [...byPhone.keys()] },
        attributes: ['id', 'fullName', 'phoneNormalized', 'marketingConsent', 'isBlacklisted'],
      });
      candidates = customers.map((c) => ({ id: c.id, fullName: c.fullName || byPhone.get(c.phoneNormalized), phoneNormalized: c.phoneNormalized, marketingConsent: c.marketingConsent, isBlacklisted: c.isBlacklisted }));
    }
  } else {
    // Segments are lane 8's: read them through their own service, a page at a time.
    const contacts = require('../contacts/contactService');
    const params = type === 'segment' ? { segmentId: audience.segmentId } : {};
    let cursor;
    do {
      const page = await contacts.listContacts(workspaceId, { ...params, limit: 200, cursor });
      candidates.push(...page.contacts);
      cursor = page.nextCursor;
    } while (cursor && candidates.length < 50000);
    audienceSize = candidates.length;
  }

  const recipients = candidates
    .filter((c) => c.marketingConsent && !c.isBlacklisted && c.phoneNormalized)
    .map((c) => ({ customerId: c.id, phoneNormalized: c.phoneNormalized, name: c.fullName || null }));
  return { recipients, audienceSize, excluded: audienceSize - recipients.length };
}

async function previewAudience(workspaceId, audience) {
  const { recipients, audienceSize, excluded } = await resolveAudience(workspaceId, audience);
  return { audienceSize, reachable: recipients.length, excluded };
}

// --------------------------------------------------------------------- CRUD --

async function list(workspaceId) {
  const campaigns = await db.WhatsappCampaign.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']], limit: 100 });
  const counts = campaigns.length
    ? await db.sequelize.query(
        `SELECT campaign_id AS "campaignId", status, COUNT(*)::int AS n FROM whatsapp_campaign_recipients
          WHERE campaign_id IN (:ids) GROUP BY campaign_id, status`,
        { replacements: { ids: campaigns.map((c) => c.id) }, type: QueryTypes.SELECT }
      )
    : [];
  const byCampaign = new Map();
  for (const row of counts) {
    const entry = byCampaign.get(row.campaignId) || { pending: 0, sent: 0, failed: 0, skipped: 0 };
    entry[row.status] = row.n;
    byCampaign.set(row.campaignId, entry);
  }
  return { campaigns: campaigns.map((c) => view(c, { recipients: byCampaign.get(c.id) || { pending: 0, sent: 0, failed: 0, skipped: 0 } })) };
}

async function assertSegment(workspaceId, audience) {
  if (audience.type !== 'segment') return;
  const segment = await db.Segment.findOne({ where: { id: audience.segmentId, workspaceId }, attributes: ['id'] });
  if (!segment) throw new ValidationError([{ field: 'audience.segmentId', message: 'This segment does not exist' }], 'Invalid body');
}

async function create(workspaceId, body, req) {
  await assertSegment(workspaceId, body.audience);
  const campaign = await db.WhatsappCampaign.create({
    workspaceId,
    name: body.name,
    audience: body.audience,
    templateName: body.template.name,
    templateLanguage: body.template.language,
    templateParams: body.template.params,
    couponCode: body.couponCode || null,
    dailyCap: body.dailyCap,
    scheduledAt: body.scheduledAt || null,
    createdByUserId: req.user.id,
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'whatsapp_campaign.create', entityType: 'WhatsappCampaign', entityId: campaign.id, req, after: { name: campaign.name, template: campaign.templateName } });
  return view(campaign);
}

async function remove(workspaceId, campaignId, req) {
  const campaign = await find(workspaceId, campaignId);
  if (!['draft', 'cancelled', 'completed'].includes(campaign.status)) throw new AppError('CAMPAIGN_ACTIVE', 'Cancel the campaign before deleting it', 409);
  await campaign.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'whatsapp_campaign.delete', entityType: 'WhatsappCampaign', entityId: campaign.id, req, before: { name: campaign.name } });
  return { deleted: true };
}

// ------------------------------------------------------------------- report --

async function report(campaign) {
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS recipients,
            COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE r.status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
            COUNT(*) FILTER (WHERE m.status IN ('delivered', 'read'))::int AS delivered,
            COUNT(*) FILTER (WHERE m.status = 'read')::int AS read,
            COUNT(*) FILTER (WHERE r.replied_at IS NOT NULL)::int AS replies,
            COUNT(*) FILTER (WHERE r.unsubscribed_at IS NOT NULL)::int AS unsubscribed
       FROM whatsapp_campaign_recipients r
       LEFT JOIN whatsapp_messages m ON m.workspace_id = r.workspace_id AND m.wa_message_id = r.wa_message_id
      WHERE r.campaign_id = :campaignId`,
    { replacements: { campaignId: campaign.id }, type: QueryTypes.SELECT }
  );
  // Orders placed by a recipient within a week of their message (test orders and cancelled ones left out).
  const [orders] = await db.sequelize.query(
    `SELECT COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(o.total_amount), 0)::text AS revenue, MIN(o.currency) AS currency
       FROM whatsapp_campaign_recipients r
       JOIN orders o ON o.workspace_id = r.workspace_id AND o.customer_id = r.customer_id
                    AND o.created_at >= r.sent_at AND o.created_at < r.sent_at + (:days || ' days')::interval
                    AND o.cancelled_at IS NULL AND COALESCE(o.is_test, FALSE) = FALSE
      WHERE r.campaign_id = :campaignId AND r.status = 'sent'`,
    { replacements: { campaignId: campaign.id, days: String(ORDER_WINDOW_DAYS) }, type: QueryTypes.SELECT }
  );
  return { ...row, orders: orders.orders, revenue: orders.revenue, currency: orders.currency, orderWindowDays: ORDER_WINDOW_DAYS };
}

async function get(workspaceId, campaignId) {
  const campaign = await find(workspaceId, campaignId);
  const failures = await db.WhatsappCampaignRecipient.findAll({
    where: { campaignId: campaign.id, status: 'failed' },
    attributes: ['phoneNormalized', 'name', 'error'],
    order: [['updatedAt', 'DESC']],
    limit: 20,
  });
  return { campaign: view(campaign, await report(campaign)), failures: failures.map((f) => ({ phone: f.phoneNormalized, name: f.name, error: f.error })) };
}

// ------------------------------------------------------------------ sending --

const queueTick = (campaign, delayMs = 0) => queue.add('notifications', TICK_JOB, { campaignId: campaign.id }, { workspaceId: campaign.workspaceId, delayMs });

/** Fixes the recipients and starts sending (now, or at `scheduledAt`). */
async function start(workspaceId, campaignId, req) {
  const campaign = await find(workspaceId, campaignId);
  if (campaign.status !== 'draft') throw new AppError('CAMPAIGN_NOT_DRAFT', 'Only a draft campaign can be started', 409);
  // Fail now, in front of the merchant, rather than on the first message.
  const integration = await require('./whatsappService').getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') throw new AppError('WHATSAPP_NOT_CONNECTED', 'Connect WhatsApp in Settings first', 422);

  const { recipients, audienceSize, excluded } = await resolveAudience(workspaceId, campaign.audience);
  if (recipients.length === 0) throw new AppError('CAMPAIGN_NO_RECIPIENTS', 'Nobody in this audience has agreed to marketing messages', 422);

  const delayMs = campaign.scheduledAt ? Math.max(0, new Date(campaign.scheduledAt).getTime() - Date.now()) : 0;
  await db.sequelize.transaction(async (transaction) => {
    await db.WhatsappCampaignRecipient.bulkCreate(
      recipients.map((r) => ({ ...r, campaignId: campaign.id, workspaceId })),
      { transaction, ignoreDuplicates: true }
    );
    await campaign.update({ status: delayMs > 0 ? 'scheduled' : 'sending', audienceSize, excludedNoConsent: excluded, startedAt: delayMs > 0 ? null : new Date(), pauseReason: null }, { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'whatsapp_campaign.start', entityType: 'WhatsappCampaign', entityId: campaign.id, req, after: { recipients: recipients.length, excluded, scheduledAt: campaign.scheduledAt }, transaction });
  });
  await queueTick(campaign, delayMs);
  return view(campaign);
}

async function setStatus(workspaceId, campaignId, action, req) {
  const campaign = await find(workspaceId, campaignId);
  const allowed = { pause: ['sending', 'scheduled'], resume: ['paused'], cancel: ['draft', 'scheduled', 'sending', 'paused'] }[action];
  if (!allowed.includes(campaign.status)) throw new AppError('CAMPAIGN_WRONG_STATE', `A ${campaign.status} campaign cannot be ${action === 'cancel' ? 'cancelled' : `${action}d`}`, 409);
  const before = campaign.status;
  if (action === 'pause') await campaign.update({ status: 'paused', pauseReason: 'manual' });
  if (action === 'resume') await campaign.update({ status: 'sending', pauseReason: null, startedAt: campaign.startedAt || new Date() });
  if (action === 'cancel') {
    await campaign.update({ status: 'cancelled', completedAt: new Date() });
    await db.WhatsappCampaignRecipient.update({ status: 'skipped', error: 'campaign cancelled' }, { where: { campaignId: campaign.id, status: 'pending' } });
  }
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: `whatsapp_campaign.${action}`, entityType: 'WhatsappCampaign', entityId: campaign.id, req, before: { status: before }, after: { status: campaign.status } });
  if (action === 'resume') await queueTick(campaign);
  return view(campaign);
}

const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** One batch of one campaign. Queues itself again until nobody is pending. */
async function tick(job) {
  const campaign = await db.WhatsappCampaign.findByPk(job.payload.campaignId);
  if (!campaign) return { done: true };
  if (campaign.status === 'scheduled') await campaign.update({ status: 'sending', startedAt: new Date() });
  if (campaign.status !== 'sending') return { stopped: campaign.status };

  const sentToday = await db.WhatsappCampaignRecipient.count({ where: { campaignId: campaign.id, status: 'sent', sentAt: { [Op.gte]: startOfDay() } } });
  const room = campaign.dailyCap - sentToday;
  if (room <= 0) {
    // The day's share is out: pick up again shortly after midnight.
    const tomorrow = startOfDay().getTime() + 24 * 60 * 60 * 1000 + 60 * 1000;
    await queueTick(campaign, tomorrow - Date.now());
    return { waiting: 'daily cap' };
  }

  const batch = await db.WhatsappCampaignRecipient.findAll({ where: { campaignId: campaign.id, status: 'pending' }, order: [['createdAt', 'ASC']], limit: Math.min(BATCH, room) });
  if (batch.length === 0) {
    await campaign.update({ status: 'completed', completedAt: new Date() });
    return { done: true };
  }

  const whatsapp = require('./whatsappService');
  const { render } = require('../automations/automationContext');
  const workspace = await db.Workspace.findByPk(campaign.workspaceId, { attributes: ['name'] });
  // Consent is checked again at send time: someone may have opted out since the campaign started.
  const consenting = new Set(
    (await db.Customer.findAll({ where: { workspaceId: campaign.workspaceId, id: batch.map((r) => r.customerId).filter(Boolean), marketingConsent: true, isBlacklisted: false }, attributes: ['id'] })).map((c) => c.id)
  );

  let failed = 0;
  for (const recipient of batch) {
    if (!consenting.has(recipient.customerId)) {
      await recipient.update({ status: 'skipped', error: 'no longer agrees to marketing messages' });
      continue;
    }
    const vars = { customer_name: recipient.name || '', store_name: workspace ? workspace.name : '', coupon_code: campaign.couponCode || '' };
    try {
      const message = await whatsapp.sendMessage(campaign.workspaceId, {
        to: recipient.phoneNormalized,
        template: { name: campaign.templateName, language: campaign.templateLanguage, params: (campaign.templateParams || []).map((p) => render(p, vars)) },
      });
      await recipient.update({ status: 'sent', waMessageId: message.waMessageId, sentAt: new Date(), error: null });
    } catch (err) {
      failed += 1;
      await recipient.update({ status: 'failed', error: String(err.message).slice(0, 500) });
      if (err.code === 'WHATSAPP_NOT_CONNECTED' || err.code === 'WHATSAPP_AUTH_FAILED') {
        await campaign.update({ status: 'paused', pauseReason: `WhatsApp is not connected: ${String(err.message).slice(0, 200)}` });
        return { paused: 'not connected' };
      }
    }
  }

  // Most of a real batch failing means the number, the template or the list is in trouble: stop before it gets worse.
  if (batch.length >= 5 && failed / batch.length >= 0.5) {
    await campaign.update({ status: 'paused', pauseReason: `${failed} of the last ${batch.length} messages failed` });
    logger.warn(`[campaigns] ${campaign.id} paused itself: ${failed}/${batch.length} failed`);
    return { paused: 'failures' };
  }
  await queueTick(campaign, TICK_GAP_MS);
  return { sent: batch.length - failed, failed };
}

// ------------------------------------------------------------------ inbound --

/**
 * Every new inbound message passes through here (whatsappService.handleWebhook):
 * it counts as a reply to the campaign that last wrote to that number, and a
 * STOP word withdraws the customer's marketing consent. Never throws.
 */
async function handleInbound(workspaceId, msg, phoneNormalized) {
  try {
    const text = msg.type === 'text' && msg.text ? msg.text.body : msg.type === 'button' && msg.button ? msg.button.text : null;
    // "إلغاء" on an order message cancels that order (quickReplyConfirmation.js); it is not an opt-out.
    const quotesOrder = msg.context && msg.context.id ? await db.WhatsappMessage.count({ where: { workspaceId, waMessageId: msg.context.id, orderId: { [Op.ne]: null } } }) : 0;
    const optOut = Boolean(text) && !quotesOrder && STOP_WORDS.has(normalise(text));

    const recent = await db.WhatsappCampaignRecipient.findOne({
      where: { workspaceId, phoneNormalized, status: 'sent', sentAt: { [Op.gt]: new Date(Date.now() - REPLY_WINDOW_MS) } },
      order: [['sentAt', 'DESC']],
    });
    if (recent) await recent.update({ repliedAt: recent.repliedAt || new Date(), ...(optOut ? { unsubscribedAt: new Date() } : {}) });

    if (optOut) {
      const [updated] = await db.Customer.update({ marketingConsent: false }, { where: { workspaceId, phoneNormalized, marketingConsent: true } });
      if (updated) {
        await recordAudit({ workspaceId, actorUserId: null, action: 'customer.marketing_consent.withdrawn', entityType: 'Customer', entityId: null, metadata: { phoneNormalized, via: 'whatsapp', word: String(text).slice(0, 40) } });
      }
    }
    return { reply: Boolean(recent), optOut };
  } catch (err) {
    logger.error(`[campaigns] inbound handling failed for ${workspaceId}: ${err.message}`);
    return { reply: false, optOut: false };
  }
}

module.exports = { TICK_JOB, MAX_LIST_ROWS, list, get, create, remove, previewAudience, start, setStatus, tick, handleInbound };
