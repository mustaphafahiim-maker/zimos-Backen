'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const secretBox = require('../../core/utils/secretBox');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');
const appGate = require('../apps/appGate');
const { BY_KEY } = require('../apps/appCatalogue');
const providers = require('./providers');

/*
 * Contacts and leads to a Mailchimp audience or a Klaviyo list (spec-gaps
 * item 182; providers/README.md). The store connects an account (the key is
 * sealed, never shown again), picks a list, optional tags and which contacts
 * (leads, buyers); from then on every new or changed contact goes there, and
 * "Sync now" sends everyone already in the store.
 *
 * Only contacts with an email who agreed to marketing (`marketingConsent`)
 * and are not blocked are ever sent; one who withdraws consent is
 * unsubscribed there.
 */

const KEY_PREFIX = 'email_marketing:';
const integrationKey = (code) => `${KEY_PREFIX}${code}`;
const SOURCES = ['leads', 'buyers'];
const BACKFILL_MAX = 20000;
const PAGE = 200;
const KNOWN = ['EMAIL_MARKETING_INVALID_CREDENTIALS', 'EMAIL_MARKETING_LIST_NOT_FOUND', 'EMAIL_MARKETING_REJECTED', 'EMAIL_MARKETING_UNAVAILABLE'];

function providerOrThrow(code) {
  const provider = providers.get(code);
  if (!provider) throw new NotFoundError('Email marketing service');
  return provider;
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (KNOWN.includes(err.code)) throw new AppError(err.code, err.message, err.status || 502);
    logger.error('[email-marketing] provider failed', { message: err.message });
    throw new AppError('EMAIL_MARKETING_UNAVAILABLE', 'The service could not be reached. Try again in a moment.', 502);
  }
}

// Mailchimp and Klaviyo are apps in the app store: they work while installed. The test one is not listed.
const gated = (code) => BY_KEY.has(code);
async function assertInstalled(workspaceId, code) {
  if (gated(code)) await appGate.assertEnabled(workspaceId, code);
}

async function connection(workspaceId, code) {
  await assertInstalled(workspaceId, code);
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (!row || row.status !== 'connected') throw new AppError('EMAIL_MARKETING_NOT_CONNECTED', 'Connect this service first', 409);
  return { row, credentials: JSON.parse(secretBox.open(row.secretsSealed)) };
}

const view = (provider, row) => {
  const c = (row && row.config) || {};
  return {
    code: provider.code,
    name: provider.name,
    isTest: Boolean(provider.isTest),
    credentialFields: provider.credentialFields,
    connected: Boolean(row && row.status === 'connected'),
    accountName: c.accountName || null,
    listId: c.listId || null,
    listName: c.listName || null,
    tags: c.tags || [],
    sources: c.sources || SOURCES,
    lastSyncAt: c.lastSyncAt || null,
    syncedCount: c.syncedCount || 0,
    syncing: Boolean(c.syncing),
    lastError: row ? row.lastError : null,
  };
};

async function listProviders(workspaceId) {
  const all = providers.list();
  const rows = await db.WorkspaceIntegration.findAll({ where: { workspaceId, provider: all.map((p) => integrationKey(p.code)) } });
  const byCode = new Map(rows.map((r) => [r.provider.slice(KEY_PREFIX.length), r]));
  return { providers: all.map((p) => view(p, byCode.get(p.code))) };
}

async function connect(workspaceId, code, credentials, req) {
  const provider = providerOrThrow(code);
  await assertInstalled(workspaceId, code);
  const info = await run(() => provider.verifyCredentials(credentials));
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  // Reconnecting with a new key keeps the chosen list and tags.
  const config = { ...((row && row.config) || {}), accountName: (info && info.accountName) || null, syncing: false };
  const values = { status: 'connected', config, secretsSealed: secretBox.seal(JSON.stringify(credentials)), lastVerifiedAt: new Date(), lastError: null };
  const saved = row ? await row.update(values) : await db.WorkspaceIntegration.create({ workspaceId, provider: integrationKey(code), ...values });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_marketing.connect', entityType: 'WorkspaceIntegration', entityId: saved.id, after: { provider: code }, req });
  return view(provider, saved);
}

async function disconnect(workspaceId, code, req) {
  providerOrThrow(code);
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (row) {
    await row.destroy();
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_marketing.disconnect', entityType: 'WorkspaceIntegration', entityId: row.id, before: { provider: code }, req });
  }
  return { code, connected: false };
}

async function lists(workspaceId, code) {
  const provider = providerOrThrow(code);
  const { credentials } = await connection(workspaceId, code);
  return { lists: await run(() => provider.lists(credentials)) };
}

async function updateSettings(workspaceId, code, body, req) {
  const provider = providerOrThrow(code);
  const { row, credentials } = await connection(workspaceId, code);
  const config = { ...row.config };
  if (body.listId !== undefined) {
    const list = (await run(() => provider.lists(credentials))).find((l) => l.id === body.listId);
    if (!list) throw new AppError('EMAIL_MARKETING_LIST_NOT_FOUND', 'That list was not found in the account', 404, [{ field: 'listId', message: 'Pick one of the account\'s lists' }]);
    config.listId = list.id;
    config.listName = list.name;
  }
  if (body.tags !== undefined) config.tags = [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))];
  if (body.sources !== undefined) config.sources = [...new Set(body.sources)];
  const before = { listId: row.config.listId || null, tags: row.config.tags || [], sources: row.config.sources || SOURCES };
  await row.update({ config });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_marketing.settings', entityType: 'WorkspaceIntegration', entityId: row.id, before, after: { listId: config.listId || null, tags: config.tags || [], sources: config.sources || SOURCES }, req });
  return view(provider, row);
}

async function startSync(workspaceId, code, req) {
  providerOrThrow(code);
  const { row } = await connection(workspaceId, code);
  if (!row.config.listId) throw new AppError('EMAIL_MARKETING_NO_LIST', 'Pick a list first', 409);
  await queue.add('io', 'email_marketing.backfill', { workspaceId, code }, { workspaceId, dedupeKey: `email-marketing:${workspaceId}:${code}:${Math.floor(Date.now() / 60000)}` });
  await row.update({ config: { ...row.config, syncing: true } });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_marketing.sync', entityType: 'WorkspaceIntegration', entityId: row.id, req });
  return { queued: true };
}

// ------------------------------------------------------------- contacts --

const eligible = (c) => Boolean(c.email && c.marketingConsent && !c.isBlacklisted);
const isBuyer = (c) => Number(c.totalOrders) > 0;
const inSources = (c, sources) => (isBuyer(c) ? sources.includes('buyers') : sources.includes('leads'));

function contactOf(c, config) {
  const [first, ...rest] = String(c.fullName || '').trim().split(/\s+/);
  return {
    email: String(c.email).trim(),
    firstName: first || null,
    lastName: rest.join(' ') || null,
    phone: c.phoneRaw || c.phoneNormalized || null,
    tags: [...new Set([...(config.tags || []), ...(c.tags || [])])].slice(0, 50),
    source: isBuyer(c) ? 'buyer' : c.source || 'lead',
  };
}

const connectedRows = (workspaceId) =>
  db.WorkspaceIntegration.findAll({ where: { workspaceId, status: 'connected', provider: { [Op.like]: `${KEY_PREFIX}%` } } });

/** lead.created / customer.created / contact.updated: that one contact, to every connected list. */
async function onContactEvent(event) {
  const payload = event.payload || {};
  const workspaceId = event.workspaceId || payload.workspaceId;
  if (!workspaceId || !payload.customerId) return null;
  const rows = (await connectedRows(workspaceId)).filter((r) => r.config && r.config.listId);
  if (rows.length === 0) return null;
  const customer = await db.Customer.findOne({ where: { id: payload.customerId, workspaceId } });
  if (!customer) return null;
  // An erased contact: its former address leaves every list (item 308).
  const erasedEmail = event.type === 'contact.erased' && payload.formerEmail ? String(payload.formerEmail) : null;
  for (const row of rows) {
    const code = row.provider.slice(KEY_PREFIX.length);
    const provider = providers.get(code);
    if (!provider || (gated(code) && !(await appGate.isEnabled(workspaceId, code)))) continue;
    const credentials = JSON.parse(secretBox.open(row.secretsSealed));
    try {
      if (erasedEmail) {
        if (!provider.unsubscribe) continue;
        await provider.unsubscribe(credentials, row.config.listId, erasedEmail);
      } else if (eligible(customer) && inSources(customer, row.config.sources || SOURCES)) {
        await provider.upsertContacts(credentials, row.config.listId, [contactOf(customer, row.config)]);
      } else if (event.type === 'contact.updated' && customer.email && (!customer.marketingConsent || customer.isBlacklisted) && provider.unsubscribe) {
        await provider.unsubscribe(credentials, row.config.listId, customer.email);
      } else continue;
      if (row.lastError) await row.update({ lastError: null });
    } catch (err) {
      // Unreachable: the outbox tries again. Refused (key revoked, list deleted…): shown on the card, not retried.
      if (err.code === 'EMAIL_MARKETING_UNAVAILABLE') throw err;
      await row.update({ lastError: String(err.message).slice(0, 500) });
    }
  }
  return null;
}

/** "Sync now": every eligible contact already in the store, in pages. */
async function backfill(job) {
  const { workspaceId, code } = job.payload || {};
  const provider = providers.get(code);
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (!provider || !row || row.status !== 'connected' || !row.config.listId) return null;
  if (gated(code) && !(await appGate.isEnabled(workspaceId, code))) return null;
  const credentials = JSON.parse(secretBox.open(row.secretsSealed));
  const sources = row.config.sources || SOURCES;
  let lastId = null;
  let synced = 0;
  let error = null;
  try {
    while (synced < BACKFILL_MAX) {
      const page = await db.Customer.findAll({
        where: {
          workspaceId,
          marketingConsent: true,
          isBlacklisted: false,
          email: { [Op.ne]: null },
          ...(lastId ? { id: { [Op.gt]: lastId } } : {}),
        },
        order: [['id', 'ASC']],
        limit: PAGE,
      });
      if (page.length === 0) break;
      lastId = page[page.length - 1].id;
      const contacts = page.filter((c) => eligible(c) && inSources(c, sources)).map((c) => contactOf(c, row.config));
      if (contacts.length) synced += (await provider.upsertContacts(credentials, row.config.listId, contacts)).synced;
    }
  } catch (err) {
    error = String(err.message).slice(0, 500);
  }
  await row.reload();
  await row.update({ lastError: error, config: { ...row.config, syncing: false, lastSyncAt: new Date().toISOString(), syncedCount: synced } });
  return { synced, error };
}

/** A sync whose worker kept stopping (core/queue, item 365): the card stops showing "syncing". */
async function backfillInterrupted(job) {
  const { workspaceId, code } = job.payload || {};
  if (!workspaceId || !code) return;
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (!row || !row.config || !row.config.syncing) return;
  await row.update({ lastError: 'The sync stopped before it finished. Sync again.', config: { ...row.config, syncing: false } });
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/workspaces/:workspaceId/email-marketing.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.APPS_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };
const code = Joi.string().pattern(/^[a-z0-9_]{2,40}$/).required();
const wid = (req) => req.tenant.workspaceId;
const settingsSchema = Joi.object({
  listId: Joi.string().trim().min(1).max(100),
  tags: Joi.array().items(Joi.string().trim().max(60)).max(10),
  sources: Joi.array().items(Joi.string().valid(...SOURCES)).min(1).max(2),
}).min(1);

router.get('/providers', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await listProviders(wid(req)))));
router.put(
  '/providers/:code',
  validate({ params: Joi.object({ ...ws, code }), body: Joi.object({ credentials: Joi.object({ apiKey: Joi.string().trim().min(6).max(200).required() }).required() }) }),
  asyncHandler(async (req, res) => res.json(await connect(wid(req), req.params.code, req.body.credentials, req)))
);
router.delete('/providers/:code', validate({ params: Joi.object({ ...ws, code }) }), asyncHandler(async (req, res) => res.json(await disconnect(wid(req), req.params.code, req))));
router.get('/providers/:code/lists', validate({ params: Joi.object({ ...ws, code }) }), asyncHandler(async (req, res) => res.json(await lists(wid(req), req.params.code))));
router.patch(
  '/providers/:code/settings',
  validate({ params: Joi.object({ ...ws, code }), body: settingsSchema }),
  asyncHandler(async (req, res) => res.json(await updateSettings(wid(req), req.params.code, req.body, req)))
);
router.post('/providers/:code/sync', validate({ params: Joi.object({ ...ws, code }) }), asyncHandler(async (req, res) => res.status(202).json(await startSync(wid(req), req.params.code, req))));

module.exports = { router, onContactEvent, backfill, backfillInterrupted, contactOf };
