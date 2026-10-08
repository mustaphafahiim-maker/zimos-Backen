'use strict';

const { Op } = require('sequelize');
const db = require('../../../db/models');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const secretBox = require('../../../core/utils/secretBox');
const { AppError, NotFoundError, ValidationError } = require('../../../core/errors/AppError');
const { checkUrl } = require('../../webhooks/webhookUrlGuard');
const { recordAudit } = require('../../audit/auditService');
const { getAdapter, describeAdapter } = require('./adapters');

/**
 * Team channels (item 378): a Telegram group, Slack channel or Discord channel
 * that receives the store's alerts — a place, not a ZIMOS seat. They reuse the
 * notification types of merchantNotificationService: a channel lists the types
 * it wants, and merchantNotificationService.create() hands every store-wide
 * notification (not the ones meant for one teammate) to deliver() below.
 *
 * Credentials (bot token + chat id, or the webhook URL) are sealed with
 * secretBox and never returned; the API shows `hint` instead. Sending goes
 * through the adapters (adapters/README.md): live in production, sandbox
 * elsewhere.
 */

const PROVIDERS = ['telegram', 'slack', 'discord'];
const MAX_CHANNELS = 10;
const PAUSE_AFTER_FAILURES = 10;
// Types meant for one teammate, or a link only they may open: never sent to a shared channel.
const PERSONAL_TYPES = new Set(['export.ready', 'shipping.batch_done', 'customer.followup', 'announcement']);

// Lazy: merchantNotificationService requires this file.
const notificationTypes = () => require('../merchantNotificationService').TYPES; // eslint-disable-line global-require
const channelTypes = () => Object.keys(notificationTypes()).filter((t) => !PERSONAL_TYPES.has(t));

const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const SLACK_URL = /^https:\/\/hooks\.slack\.com\/(services|triggers|workflows)\/[A-Za-z0-9/_-]{10,300}$/;
const DISCORD_URL = /^https:\/\/((ptb|canary)\.)?discord(app)?\.com\/api\/(v\d+\/)?webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

const invalid = (field, message) => new ValidationError([{ field, message }], 'Invalid team channel');

/**
 * The credentials to seal for `provider` from a request body, laid over the
 * stored ones on an update (a Telegram chat can move without retyping the token).
 */
function buildCredentials(provider, body, current = {}) {
  if (provider === 'telegram') {
    const botToken = body.botToken !== undefined ? String(body.botToken).trim() : current.botToken;
    const chatId = body.chatId !== undefined ? String(body.chatId).trim() : current.chatId;
    if (!botToken || !TELEGRAM_TOKEN.test(botToken)) throw invalid('botToken', 'Paste the token @BotFather gave you, like 123456789:AAE…');
    if (!chatId || !TELEGRAM_CHAT.test(chatId)) throw invalid('chatId', 'The group or channel id, like -1001234567890 or @mychannel');
    return { credentials: { botToken, chatId }, hint: `${chatId} · ${secretBox.mask(botToken)}` };
  }
  const webhookUrl = body.webhookUrl !== undefined ? String(body.webhookUrl).trim() : current.webhookUrl;
  const pattern = provider === 'slack' ? SLACK_URL : DISCORD_URL;
  if (!webhookUrl || !pattern.test(webhookUrl)) {
    throw invalid(
      'webhookUrl',
      provider === 'slack' ? 'A Slack incoming-webhook URL, like https://hooks.slack.com/services/…' : 'A Discord webhook URL, like https://discord.com/api/webhooks/…'
    );
  }
  checkUrl(webhookUrl, 'webhookUrl');
  return { credentials: { webhookUrl }, hint: `${new URL(webhookUrl).hostname} ${secretBox.mask(webhookUrl)}` };
}

const seal = (credentials) => secretBox.seal(JSON.stringify(credentials));
function openCredentials(channel) {
  try {
    return JSON.parse(secretBox.open(channel.credentials));
  } catch (err) {
    return null;
  }
}

function serialize(c) {
  return {
    id: c.id,
    provider: c.provider,
    name: c.name,
    hint: c.hint,
    locale: c.locale,
    types: c.types || [],
    isActive: c.isActive,
    lastStatus: c.lastStatus,
    lastError: c.lastError,
    lastSentAt: c.lastSentAt,
    failureCount: c.failureCount,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The caller may only route a type they could receive themselves. */
function checkTypes(types, req) {
  const all = notificationTypes();
  const allowed = new Set(channelTypes());
  for (const type of types || []) {
    if (!allowed.has(type)) throw invalid('types', `"${type}" cannot be sent to a team channel`);
    const permission = all[type].permission;
    if (permission && !req.tenant.hasPermission(permission)) {
      throw new AppError('TEAM_CHANNEL_TYPE_FORBIDDEN', `You cannot route "${type}" alerts: it needs ${permission}`, 403);
    }
  }
  return [...new Set(types || [])];
}

async function find(workspaceId, id, transaction) {
  const channel = await db.TeamChannel.findOne({ where: { id, workspaceId }, transaction });
  if (!channel) throw new NotFoundError('TeamChannel');
  return channel;
}

async function list(workspaceId, req) {
  const channels = await db.TeamChannel.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  const all = notificationTypes();
  return {
    channels: channels.map(serialize),
    providers: PROVIDERS,
    // The types this person may route to a channel.
    types: channelTypes().filter((t) => !all[t].permission || req.tenant.hasPermission(all[t].permission)),
    adapter: describeAdapter(),
  };
}

async function create(workspaceId, body, req) {
  const types = checkTypes(body.types || ['order.new'], req);
  const { credentials, hint } = buildCredentials(body.provider, body);
  const channel = await db.sequelize.transaction(async (transaction) => {
    const count = await db.TeamChannel.count({ where: { workspaceId }, transaction });
    if (count >= MAX_CHANNELS) throw new AppError('TEAM_CHANNEL_LIMIT', `A store can have up to ${MAX_CHANNELS} team channels`, 409);
    const row = await db.TeamChannel.create(
      {
        workspaceId,
        provider: body.provider,
        name: body.name,
        credentials: seal(credentials),
        hint,
        locale: body.locale || 'ar',
        types,
        isActive: body.isActive !== false,
        createdByUserId: req.user ? req.user.id : null,
      },
      { transaction }
    );
    await recordAudit({ workspaceId, actorUserId: req.user && req.user.id, action: 'team_channel.create', entityType: 'TeamChannel', entityId: row.id, after: serialize(row), req, transaction });
    return row;
  });
  return { channel: serialize(channel) };
}

async function update(workspaceId, id, body, req) {
  const channel = await find(workspaceId, id);
  const before = serialize(channel);
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.locale !== undefined) patch.locale = body.locale;
  if (body.types !== undefined) patch.types = checkTypes(body.types, req);
  if (body.isActive !== undefined) {
    patch.isActive = body.isActive;
    // Switched back on: its failure streak starts over.
    if (body.isActive && !channel.isActive) patch.failureCount = 0;
  }
  if (['botToken', 'chatId', 'webhookUrl'].some((k) => body[k] !== undefined)) {
    // A new destination needs the permissions of the types it will receive, as subscribing to them does.
    if (body.types === undefined) checkTypes(channel.types, req);
    const { credentials, hint } = buildCredentials(channel.provider, body, openCredentials(channel) || {});
    patch.credentials = seal(credentials);
    patch.hint = hint;
    patch.failureCount = 0;
    patch.lastError = null;
  }
  await channel.update(patch);
  await recordAudit({ workspaceId, actorUserId: req.user && req.user.id, action: 'team_channel.update', entityType: 'TeamChannel', entityId: channel.id, before, after: serialize(channel), req });
  return { channel: serialize(channel) };
}

async function remove(workspaceId, id, req) {
  const channel = await find(workspaceId, id);
  await channel.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user && req.user.id, action: 'team_channel.delete', entityType: 'TeamChannel', entityId: channel.id, before: serialize(channel), req });
  return { deleted: true, id: channel.id };
}

async function deliveries(workspaceId, id) {
  await find(workspaceId, id);
  const rows = await db.TeamChannelDelivery.findAll({ where: { workspaceId, teamChannelId: id }, order: [['createdAt', 'DESC']], limit: 50 });
  return { deliveries: rows.map((d) => ({ id: d.id, type: d.type, status: d.status, error: d.error, createdAt: d.createdAt })) };
}

/** title, body and the dashboard link, in the channel's language when the caller wrote both. */
function compose(channel, { title, body, link, localized }) {
  const own = localized && localized[channel.locale === 'en' ? 'en' : 'ar'];
  const words = own && own.title ? { title: own.title, body: own.body === undefined ? body : own.body } : { title, body };
  const url = link ? `${env.frontendUrl.replace(/\/$/, '')}${link}` : null;
  return [words.title, words.body, url].filter(Boolean).map(String).join('\n');
}

/**
 * Sends one message to one channel and keeps its health: a success clears the
 * failure streak; a failure is counted, and the 10th in a row pauses the
 * channel and tells the store's managers (integration.failed). Never throws
 * unless `rethrow`.
 */
async function sendTo(channel, text, { type, dedupeKey = null, rethrow = false }) {
  let delivery;
  try {
    // With a dedupe key the row is the claim: a second delivery of the same alert hits the unique index.
    delivery = await db.TeamChannelDelivery.create({ workspaceId: channel.workspaceId, teamChannelId: channel.id, type, dedupeKey, status: 'pending' });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return { status: 'duplicate' };
    throw err;
  }
  let error = null;
  try {
    const credentials = openCredentials(channel);
    if (!credentials) throw new Error('The saved credentials cannot be read; enter them again');
    const adapter = getAdapter(channel.provider);
    await adapter.send(credentials, text.slice(0, adapter.maxLength), channel.provider);
  } catch (err) {
    error = String(err.message || err).slice(0, 500);
  }
  await delivery.update({ status: error ? 'failed' : 'sent', error });
  if (error) {
    // Counted in the database: deliveries to one channel run side by side, so a loaded copy is stale.
    const [[row]] = await db.sequelize.query(
      'UPDATE team_channels SET failure_count = failure_count + 1, last_status = :status, last_error = :error, updated_at = NOW() WHERE id = :id RETURNING failure_count',
      { replacements: { id: channel.id, status: 'failed', error } }
    );
    const failureCount = row ? row.failure_count : channel.failureCount + 1;
    // Only the send that switches it off raises the alert.
    const [paused] = failureCount >= PAUSE_AFTER_FAILURES ? await db.TeamChannel.update({ isActive: false }, { where: { id: channel.id, isActive: true } }) : [0];
    const pause = paused > 0;
    Object.assign(channel.dataValues, { lastStatus: 'failed', lastError: error, failureCount, ...(pause ? { isActive: false } : {}) });
    logger.warn(`[team-channel] ${channel.provider} ${channel.id} failed: ${error}`);
    if (pause) {
      // eslint-disable-next-line global-require
      await require('../merchantNotificationEvents').integrationFailed(channel.workspaceId, {
        integration: `${channel.provider[0].toUpperCase()}${channel.provider.slice(1)}: ${channel.name}`,
        message: `توقف الإرسال بعد ${PAUSE_AFTER_FAILURES} رسائل فاشلة متتالية. آخر خطأ: ${error}`,
        link: '/settings/notifications',
      });
    }
    if (rethrow) throw new AppError('TEAM_CHANNEL_SEND_FAILED', error, 502);
    return { status: 'failed', error };
  }
  // Written by id, not through the loaded copy, whose stale failureCount 0 would not be saved.
  const sent = { lastStatus: 'sent', lastError: null, lastSentAt: new Date(), failureCount: 0 };
  await db.TeamChannel.update(sent, { where: { id: channel.id } });
  Object.assign(channel.dataValues, sent);
  return { status: 'sent' };
}

/**
 * Called by merchantNotificationService.create for every store-wide
 * notification: each active channel that asked for this type gets it, once
 * per dedupe key. Never throws.
 */
async function deliver(workspaceId, notification) {
  try {
    if (PERSONAL_TYPES.has(notification.type)) return { sent: 0 };
    const channels = await db.TeamChannel.findAll({
      where: { workspaceId, isActive: true, types: { [Op.contains]: [notification.type] } },
    });
    let sent = 0;
    for (const channel of channels) {
      const result = await sendTo(channel, compose(channel, notification), { type: notification.type, dedupeKey: notification.dedupeKey || null });
      if (result.status === 'sent') sent += 1;
    }
    return { sent };
  } catch (err) {
    logger.error(`[team-channel] ${notification.type} for workspace ${workspaceId} failed: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

/** POST /team-channels/:id/test — works on a paused channel too, to check it before switching it back on. */
async function test(workspaceId, id, req) {
  const channel = await find(workspaceId, id);
  getAdapter(channel.provider); // 503 TEAM_CHANNEL_UNAVAILABLE before anything is recorded
  const text =
    channel.locale === 'en'
      ? `ZIMOS test message: alerts for this store will arrive here (${channel.name}).`
      : `رسالة تجريبية من ZIMOS: تنبيهات المتجر ستصل هنا (${channel.name}).`;
  const result = await sendTo(channel, text, { type: 'test' });
  await recordAudit({ workspaceId, actorUserId: req.user && req.user.id, action: 'team_channel.test', entityType: 'TeamChannel', entityId: channel.id, after: { status: result.status }, req });
  return { result, channel: serialize(await channel.reload()) };
}

/** An automation's notify_channel step: throws so the run row says why it failed. */
async function sendAutomationMessage(workspaceId, channelId, text) {
  const channel = await db.TeamChannel.findOne({ where: { id: channelId, workspaceId } });
  if (!channel) throw new Error('the team channel no longer exists');
  if (!channel.isActive) throw new Error(`team channel "${channel.name}" is paused`);
  await sendTo(channel, text, { type: 'automation_step', rethrow: true });
  return channel;
}

/** Delivery rows are kept 30 days (notifications/jobs.js). */
function prune() {
  return db.TeamChannelDelivery.destroy({ where: { createdAt: { [Op.lt]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } });
}

module.exports = { PROVIDERS, PERSONAL_TYPES, list, create, update, remove, deliveries, deliver, test, sendAutomationMessage, prune, compose };
