'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const { QueryTypes, Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { blocksSchema, renderBlocks } = require('../notifications/emailBlocks');
const { STATS_CTE } = require('../contacts/segmentRules');
const { recordAudit } = require('../audit/auditService');

/*
 * Email campaigns (spec-gaps item 200): a broadcast the merchant designs with
 * the email block designer and sends to their contacts.
 *
 * - Audience: contacts with marketing consent and an email, narrowed by a
 *   saved segment and/or a tag. Never a blacklisted contact, an address or
 *   phone that unsubscribed or answered STOP, or a blocked address or phone
 *   (the same refusals as every marketing message, automations/marketingGuard).
 * - Sending snapshots the audience into recipients (one per address), then
 *   sends in batches of BATCH on the `notifications` queue; each send checks
 *   the refusals again, so an unsubscribe in the meantime is honoured.
 * - Scheduling: `scheduled` campaigns start when due (a schedule every minute).
 * - Every email ends with the store's unsubscribe link (the marketing
 *   unsubscribe page, notifications/marketingUnsubscribe.js — its token names
 *   the recipient), and carries a 1×1 open pixel; opened = the first time it
 *   loads (mail apps that block images don't count).
 * - Text takes {{first_name}}, {{full_name}}, {{store_name}}, {{store_link}}.
 */

const BATCH = 100;
const MAX_RECIPIENTS = 100000;
const STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'];
const EDITABLE = ['draft', 'scheduled'];

const campaignBlocks = blocksSchema.custom((blocks, helpers) => (blocks.some((b) => b.type === 'order_table') ? helpers.message('A campaign has no order table') : blocks));
const audienceSchema = Joi.object({ segmentId: Joi.string().uuid().allow(null), tag: Joi.string().trim().max(60).allow(null, '') });

// ------------------------------------------------------------- audience --

async function audienceSql(workspaceId, audience = {}) {
  const { where, replacements } = await require('../contacts/contactService').buildFilter(workspaceId, {
    consent: true,
    segmentId: audience.segmentId || undefined,
    tag: audience.tag || undefined,
  });
  const sql = `SELECT DISTINCT ON (lower(trim(c.email))) c.id, lower(trim(c.email)) AS email, c.full_name
      FROM customers c
      LEFT JOIN stats s ON s.customer_id = c.id
     WHERE ${where}
       AND c.email IS NOT NULL AND trim(c.email) <> '' AND c.is_blacklisted = false
       AND NOT EXISTS (SELECT 1 FROM marketing_opt_outs m WHERE m.workspace_id = c.workspace_id
                         AND (m.email = lower(trim(c.email)) OR (c.phone_normalized IS NOT NULL AND m.phone_normalized = c.phone_normalized)))
       AND NOT EXISTS (SELECT 1 FROM blocked_entries b WHERE b.workspace_id = c.workspace_id
                         AND ((b.type = 'email' AND b.value = lower(trim(c.email))) OR (b.type = 'phone' AND b.value = c.phone_normalized)))
     ORDER BY lower(trim(c.email)), c.created_at`;
  return { sql, replacements };
}

async function audienceCount(workspaceId, audience) {
  const { sql, replacements } = await audienceSql(workspaceId, audience);
  const [row] = await db.sequelize.query(`WITH ${STATS_CTE} SELECT COUNT(*)::int AS n FROM (${sql}) a`, { replacements, type: QueryTypes.SELECT });
  return row.n;
}

// -------------------------------------------------------------- present --

async function statsOf(campaignIds) {
  if (!campaignIds.length) return new Map();
  const rows = await db.sequelize.query(
    `SELECT campaign_id AS id, COUNT(*)::int AS recipients,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
            COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened
       FROM email_campaign_recipients WHERE campaign_id IN (:ids) GROUP BY campaign_id`,
    { replacements: { ids: campaignIds }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function view(c, stats) {
  const s = stats || { recipients: 0, sent: 0, failed: 0, skipped: 0, queued: 0, opened: 0 };
  return {
    id: c.id,
    name: c.name,
    subject: c.subject,
    blocks: c.blocks,
    audience: { segmentId: c.audience.segmentId || null, tag: c.audience.tag || null },
    status: c.status,
    scheduledAt: c.scheduledAt,
    startedAt: c.startedAt,
    sentAt: c.sentAt,
    stats: { recipients: s.recipients, sent: s.sent, failed: s.failed, skipped: s.skipped, queued: s.queued, opened: s.opened, openRate: s.sent ? Math.round((s.opened / s.sent) * 1000) / 10 : null },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function find(workspaceId, id) {
  const c = await db.EmailCampaign.findOne({ where: { id, workspaceId } });
  if (!c) throw new NotFoundError('Campaign');
  return c;
}

async function list(workspaceId, { status } = {}) {
  const rows = await db.EmailCampaign.findAll({ where: { workspaceId, ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  const stats = await statsOf(rows.map((r) => r.id));
  return { campaigns: rows.map((r) => view(r, stats.get(r.id))) };
}

async function get(workspaceId, id) {
  const c = await find(workspaceId, id);
  const out = view(c, (await statsOf([c.id])).get(c.id));
  // Before it goes, how many it would reach now.
  if (EDITABLE.includes(c.status)) out.audienceCount = await audienceCount(workspaceId, c.audience).catch(() => null);
  return out;
}

// ---------------------------------------------------------------- edits --

async function create(workspaceId, body, req) {
  if (body.audience && body.audience.segmentId) await audienceCount(workspaceId, body.audience); // 404 for another store's segment
  const c = await db.EmailCampaign.create({ workspaceId, name: body.name, subject: body.subject, blocks: body.blocks, audience: body.audience || {}, createdBy: req.user.id });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.create', entityType: 'EmailCampaign', entityId: c.id, after: { name: c.name }, req });
  return get(workspaceId, c.id);
}

async function update(workspaceId, id, body, req) {
  const c = await find(workspaceId, id);
  if (!EDITABLE.includes(c.status)) throw new AppError('CAMPAIGN_LOCKED', 'A campaign that is sending or sent cannot be changed', 409);
  if (body.audience && body.audience.segmentId) await audienceCount(workspaceId, body.audience);
  await c.update(Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'subject', 'blocks', 'audience'].includes(k))));
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.update', entityType: 'EmailCampaign', entityId: c.id, req });
  return get(workspaceId, c.id);
}

async function remove(workspaceId, id, req) {
  const c = await find(workspaceId, id);
  if (c.status === 'sending') throw new AppError('CAMPAIGN_SENDING', 'Cancel the campaign before deleting it', 409);
  await c.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.delete', entityType: 'EmailCampaign', entityId: id, before: { name: c.name, status: c.status }, req });
}

// ------------------------------------------------------------- rendering --

const pixelKey = () => crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:campaign-open').digest();
const pixelToken = (recipientId) => `${recipientId}.${crypto.createHmac('sha256', pixelKey()).update(recipientId).digest('base64url').slice(0, 22)}`;
function readPixel(token) {
  const [id, sig] = String(token || '').replace(/\.gif$/, '').split('.');
  if (!id || !sig) return null;
  const expected = pixelToken(id).split('.')[1];
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

async function contextOf(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'logoUrl', 'themeSettings'] });
  const origin = await require('../domains/primaryHost').storeOriginOf(workspace && workspace.slug ? workspace : null).catch(() => null);
  const color = workspace.themeSettings && /^#[0-9a-f]{6}$/i.test(workspace.themeSettings.primaryColor || '') ? workspace.themeSettings.primaryColor : null;
  const sender = await require('../notifications/orderEmailSender').senderFor(workspaceId);
  return { workspace, origin, brand: { storeName: workspace.name, logoUrl: workspace.logoUrl, color }, sender };
}

/** The email for one person: { subject, bodyHtml, bodyText } with their values filled in. */
function compose(campaign, ctx, person, { pixelUrl = null } = {}) {
  const fullName = (person.fullName || '').trim();
  const vars = { first_name: fullName.split(/\s+/)[0] || '', full_name: fullName, store_name: ctx.brand.storeName || '', store_link: ctx.origin || '' };
  const fill = (t) => String(t || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  const { html, text } = renderBlocks(campaign.blocks, { fill, color: ctx.brand.color || undefined });
  const pixel = pixelUrl ? `\n<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />` : '';
  return { subject: fill(campaign.subject), bodyHtml: html + pixel, bodyText: text };
}

async function preview(workspaceId, id, draft = {}) {
  const c = await find(workspaceId, id);
  const ctx = await contextOf(workspaceId);
  const merged = { subject: draft.subject || c.subject, blocks: draft.blocks || c.blocks };
  const mail = compose(merged, ctx, { fullName: 'Sara Ahmed' });
  const rendered = require('../notifications/emailTemplates').render('campaign_email', { ...ctx.brand, ...mail, unsubscribeUrl: ctx.origin ? `${ctx.origin}/unsubscribe?t=preview` : null });
  return { subject: rendered.subject, html: rendered.html, text: rendered.text };
}

async function testSend(workspaceId, id, emails, req) {
  const c = await find(workspaceId, id);
  const to = emails && emails.length ? emails : [req.user.email].filter(Boolean);
  if (!to.length) throw new ValidationError([{ field: 'emails', message: 'Give an address to send the test to' }]);
  const ctx = await contextOf(workspaceId);
  const results = [];
  for (const recipient of to) {
    const mail = compose(c, ctx, { fullName: req.user.fullName || req.user.name || '' });
    const sent = await require('../notifications/notify').email({ recipient, template: 'campaign_email', workspaceId, data: { ...ctx.brand, ...ctx.sender, ...mail, subject: `[Test] ${mail.subject}` } });
    results.push({ email: recipient, status: sent.status });
  }
  return { results };
}

// --------------------------------------------------------------- sending --

/** Snapshot the audience and start sending (now). */
async function start(campaign) {
  const { sql, replacements } = await audienceSql(campaign.workspaceId, campaign.audience);
  const begun = await db.sequelize.transaction(async (transaction) => {
    const [claimed] = await db.EmailCampaign.update({ status: 'sending', startedAt: new Date() }, { where: { id: campaign.id, status: EDITABLE }, transaction });
    if (!claimed) return false;
    await db.sequelize.query(
      `WITH ${STATS_CTE}
       INSERT INTO email_campaign_recipients (campaign_id, workspace_id, customer_id, email, full_name)
       SELECT :campaignId, :workspaceId, a.id, a.email, a.full_name FROM (${sql}) a LIMIT ${MAX_RECIPIENTS}
       ON CONFLICT (campaign_id, email) DO NOTHING`,
      { replacements: { ...replacements, campaignId: campaign.id }, transaction }
    );
    await queue.add('notifications', 'email_campaigns.send_batch', { campaignId: campaign.id }, { transaction, workspaceId: campaign.workspaceId, dedupeKey: `email-campaign:${campaign.id}:start` });
    return true;
  });
  return begun;
}

async function send(workspaceId, id, { scheduledAt } = {}, req) {
  const c = await find(workspaceId, id);
  if (!EDITABLE.includes(c.status)) throw new AppError('CAMPAIGN_LOCKED', 'This campaign was already sent', 409);
  const count = await audienceCount(workspaceId, c.audience);
  if (!count) throw new AppError('NO_RECIPIENTS', 'No contact in this audience agreed to marketing emails', 409);
  const at = scheduledAt ? new Date(scheduledAt) : null;
  if (at && at.getTime() > Date.now() + 60e3) {
    await c.update({ status: 'scheduled', scheduledAt: at });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.schedule', entityType: 'EmailCampaign', entityId: c.id, after: { scheduledAt: at, audienceCount: count }, req });
  } else {
    await start(c);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.send', entityType: 'EmailCampaign', entityId: c.id, after: { audienceCount: count }, req });
  }
  return get(workspaceId, c.id);
}

/** Scheduled → back to draft; sending → cancelled (the rest are skipped). */
async function cancel(workspaceId, id, req) {
  const c = await find(workspaceId, id);
  if (c.status === 'scheduled') await c.update({ status: 'draft', scheduledAt: null });
  else if (c.status === 'sending') {
    await c.update({ status: 'cancelled' });
    await db.EmailCampaignRecipient.update({ status: 'skipped', error: 'cancelled' }, { where: { campaignId: c.id, status: 'queued' } });
  } else throw new AppError('CAMPAIGN_NOT_CANCELLABLE', 'Only a scheduled or sending campaign can be cancelled', 409);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.cancel', entityType: 'EmailCampaign', entityId: c.id, req });
  return get(workspaceId, c.id);
}

/** The queue job: one batch, then the next one queued. */
async function sendBatch(campaignId) {
  const c = await db.EmailCampaign.findByPk(campaignId);
  if (!c || c.status !== 'sending') return;
  const batch = await db.EmailCampaignRecipient.findAll({ where: { campaignId, status: 'queued' }, order: [['id', 'ASC']], limit: BATCH });
  if (!batch.length) {
    await db.EmailCampaign.update({ status: 'sent', sentAt: new Date() }, { where: { id: campaignId, status: 'sending' } });
    return;
  }
  const ctx = await contextOf(c.workspaceId);
  const guard = require('../automations/marketingGuard');
  const unsubscribe = require('../notifications/marketingUnsubscribe');
  const notify = require('../notifications/notify');
  const apiBase = `${env.appUrl.replace(/\/$/, '')}/api/${env.apiVersion}`;
  for (const r of batch) {
    const customer = r.customerId ? await db.Customer.findByPk(r.customerId, { attributes: ['phoneNormalized', 'marketingConsent'] }) : null;
    const refused = customer && !customer.marketingConsent ? 'consent withdrawn' : await guard.refusal(c.workspaceId, customer && customer.phoneNormalized, r.email);
    if (refused) {
      await r.update({ status: 'skipped', error: String(refused).slice(0, 300) });
      continue;
    }
    const mail = compose(c, ctx, { fullName: r.fullName }, { pixelUrl: `${apiBase}/email-campaigns/open/${pixelToken(r.id)}.gif` });
    const sent = await notify.email({
      recipient: r.email,
      template: 'campaign_email',
      workspaceId: c.workspaceId,
      data: { ...ctx.brand, ...ctx.sender, ...mail, unsubscribeUrl: unsubscribe.linkFor(ctx.origin, c.workspaceId, `r:${r.id}`) },
    });
    await r.update(sent.status === 'sent' ? { status: 'sent', sentAt: new Date() } : { status: 'failed', error: String(sent.error || 'failed').slice(0, 300) });
  }
  await queue.add('notifications', 'email_campaigns.send_batch', { campaignId }, { workspaceId: c.workspaceId, delayMs: 250 });
}

/** The schedule: start every campaign whose time has come. */
async function startDue() {
  const due = await db.EmailCampaign.findAll({ where: { status: 'scheduled', scheduledAt: { [Op.lte]: new Date() } }, limit: 50 });
  for (const c of due) await start(c).catch((err) => logger.error(`[emailCampaigns] ${c.id} did not start: ${err.message}`));
}

// --------------------------------------------------- opens / unsubscribes --

async function recordOpen(token) {
  const id = readPixel(token);
  if (!id) return;
  await db.EmailCampaignRecipient.update({ openedAt: new Date() }, { where: { id, openedAt: null, status: 'sent' } });
}

/** The unsubscribe link of a campaign email (marketingUnsubscribe.unsubscribe → here). */
async function unsubscribeRecipient(workspace, recipientId) {
  const r = await db.EmailCampaignRecipient.findOne({ where: { id: recipientId, workspaceId: workspace.id } });
  if (!r) throw new AppError('INVALID_LINK', 'This link is not valid', 404);
  const customer = r.customerId ? await db.Customer.findByPk(r.customerId, { attributes: ['id', 'phoneNormalized'] }) : null;
  await require('../notifications/marketingUnsubscribe').optOut(workspace, {
    email: r.email,
    phoneNormalized: customer ? customer.phoneNormalized : null,
    customerId: customer ? customer.id : null,
    entityType: 'EmailCampaign',
    entityId: r.campaignId,
  });
}

async function recipients(workspaceId, id, { status, offset = 0, limit = 50 }) {
  await find(workspaceId, id);
  const where = { campaignId: id, ...(status === 'opened' ? { openedAt: { [Op.ne]: null } } : status ? { status } : {}) };
  const { rows, count } = await db.EmailCampaignRecipient.findAndCountAll({ where, order: [['email', 'ASC']], offset, limit });
  return { recipients: rows.map((r) => ({ email: r.email, fullName: r.fullName, customerId: r.customerId, status: r.status, error: r.error, sentAt: r.sentAt, openedAt: r.openedAt })), total: count };
}

module.exports = {
  STATUSES, campaignBlocks, audienceSchema,
  pixelToken, audienceCount, list, get, create, update, remove, preview, testSend, send, cancel, sendBatch, startDue, recordOpen, unsubscribeRecipient, recipients,
};
