'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { provider, activeName } = require('./providers');

/*
 * A store's sending domain for customer emails (Lightfunnels' email domain;
 * README.md here). Kept in workspace.settings:
 *
 *   email_sending_domain = { domain, localPart, provider, providerRef, status: pending|verified|failed,
 *                            records: [{ purpose, type, name, value, ok? }], lastCheckedAt, verifiedAt }
 *
 * Only a verified domain changes the From address (fromAddressFor, read by
 * notifications/orderEmailSender.senderFor), and only one verified by the
 * provider in use now (item 395): a row verified by the sandbox (or by an
 * earlier provider) reads as pending, with providerChanged, sends from the
 * platform's address, holds no claim on the domain, and is added again at the
 * current provider on the next Verify.
 */

const KEY = 'email_sending_domain';
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const stored = (workspace) => {
  const v = workspace && workspace.settings && workspace.settings[KEY];
  return v && typeof v === 'object' && v.domain ? v : null;
};

// Set up with another provider than the one in use now (e.g. the sandbox, then Brevo in production).
const stale = (s, current = activeName()) => Boolean(s && s.provider !== current);

const view = (s, current = activeName()) => {
  if (!s) return null;
  const old = stale(s, current);
  return {
    domain: s.domain,
    localPart: s.localPart,
    fromAddress: `${s.localPart}@${s.domain}`,
    status: old ? 'pending' : s.status,
    records: old ? [] : s.records || [],
    provider: s.provider,
    providerChanged: old,
    lastCheckedAt: s.lastCheckedAt || null,
    verifiedAt: old ? null : s.verifiedAt || null,
  };
};

/** The From address a store's customer emails use, or null (the platform's address). */
async function fromAddressFor(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const s = stored(workspace);
  return s && s.status === 'verified' && !stale(s) ? `${s.localPart}@${s.domain}` : null;
}

async function write(workspaceId, next, req, action, metadata) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = stored(workspace);
    const value = typeof next === 'function' ? await next(before) : next;
    workspace.settings = { ...(workspace.settings || {}), [KEY]: value };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType: 'Workspace', entityId: workspaceId, metadata, req, transaction });
    return view(value);
  });
}

const field = (name) => db.sequelize.literal(`settings->'${KEY}'->>'${name}'`);

/** Whether another store has verified this domain with the provider in use now. */
async function verifiedElsewhere(workspaceId, name, providerName) {
  return (await db.Workspace.count({
    where: {
      id: { [Op.ne]: workspaceId },
      [Op.and]: [db.sequelize.where(field('domain'), name), db.sequelize.where(field('status'), 'verified'), db.sequelize.where(field('provider'), providerName)],
    },
  })) > 0;
}

/** Whether another store still has this domain (any status) at the provider: then it is not deleted there. */
async function usedElsewhere(workspaceId, name, providerName) {
  return (await db.Workspace.count({
    where: { id: { [Op.ne]: workspaceId }, [Op.and]: [db.sequelize.where(field('domain'), name), db.sequelize.where(field('provider'), providerName)] },
  })) > 0;
}

/** Remove a store's domain from its provider, unless it belongs to another provider or another store still uses it. */
async function release(workspaceId, s, p) {
  if (!s || !p || s.provider !== p.name || !s.providerRef) return;
  if (await usedElsewhere(workspaceId, s.domain, p.name)) return;
  await p.removeDomain({ domain: s.domain, providerRef: s.providerRef }).catch(() => null);
}

async function get(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const current = activeName();
  return { sendingDomain: view(stored(workspace), current), available: Boolean(current) };
}

async function add(workspaceId, { domain, localPart }, req) {
  const name = String(domain).trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN.test(name)) throw new AppError('VALIDATION_ERROR', 'Enter a domain like mystore.com', 422, [{ field: 'domain', message: 'Enter a domain like mystore.com' }]);
  const p = provider();
  // Only a store that proved the domain (verified) holds it (item 310): a claim left pending can't lock the real owner out.
  const taken = await verifiedElsewhere(workspaceId, name, p.name);
  if (taken) throw new ConflictError('Another store already sends from this domain', 'EMAIL_DOMAIN_TAKEN');
  const { providerRef, records } = await p.addDomain(name);
  const value = { domain: name, localPart: localPart || 'orders', provider: p.name, providerRef, status: 'pending', records, lastCheckedAt: null, verifiedAt: null };
  const result = await write(
    workspaceId,
    async (before) => {
      if (before && before.domain !== name) await release(workspaceId, before, p);
      // The same domain added again by this store: the provider now calls it "already there", but it is still ours to delete.
      if (before && before.domain === name && before.provider === p.name && before.providerRef) return { ...value, providerRef: before.providerRef };
      return value;
    },
    req,
    'email_domain.add',
    { domain: name }
  );
  // A domain bought here gets these records in its zone at once (domains/purchaseDns.js, item 385).
  await require('../domains/purchaseDns').addSendingRecords(workspaceId, name, req);
  return { sendingDomain: result };
}

async function setLocalPart(workspaceId, localPart, req) {
  const current = (await get(workspaceId)).sendingDomain;
  if (!current) throw new NotFoundError('Sending domain');
  return { sendingDomain: await write(workspaceId, (before) => ({ ...before, localPart }), req, 'email_domain.local_part', { localPart }) };
}

async function verify(workspaceId, req) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  let s = stored(workspace);
  if (!s) throw new NotFoundError('Sending domain');
  const p = provider();
  // Two stores may wait on the same domain; the first to verify it has it.
  if (await verifiedElsewhere(workspaceId, s.domain, p.name)) throw new ConflictError('Another store already sends from this domain', 'EMAIL_DOMAIN_TAKEN');
  // Set up with another provider (the sandbox, before Brevo): added at this one first, with its own records.
  const moved = s.provider !== p.name;
  if (moved) {
    const added = await p.addDomain(s.domain);
    s = { ...s, provider: p.name, providerRef: added.providerRef, records: added.records, status: 'pending', verifiedAt: null };
  }
  const result = await p.verify({ domain: s.domain, providerRef: s.providerRef, records: s.records });
  const now = new Date().toISOString();
  const next = {
    ...s,
    ...(result.providerRef ? { providerRef: result.providerRef } : {}),
    records: result.records,
    status: result.verified ? 'verified' : s.status === 'verified' ? 'failed' : 'pending',
    lastCheckedAt: now,
    verifiedAt: result.verified ? s.verifiedAt || now : s.verifiedAt,
  };
  const sendingDomain = await write(workspaceId, next, req, 'email_domain.verify', { domain: s.domain, verified: result.verified });
  if (moved) await require('../domains/purchaseDns').addSendingRecords(workspaceId, s.domain, req);
  return { sendingDomain };
}

async function remove(workspaceId, req) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const s = stored(workspace);
  if (!s) throw new NotFoundError('Sending domain');
  // With no provider available (503) the domain is still removed here.
  let p = null;
  try {
    p = provider();
  } catch {
    p = null;
  }
  await release(workspaceId, s, p);
  await write(workspaceId, null, req, 'email_domain.remove', { domain: s.domain });
  return { sendingDomain: null };
}

// Mounted on the order emails router (workspace.manage), before its /:key routes.
const router = Router({ mergeParams: true });
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });
const localPart = Joi.string().trim().lowercase().pattern(LOCAL).messages({ 'string.pattern.base': 'Use letters, digits, ".", "_" or "-"' });
router.get('/sending-domain', validate({ params }), asyncHandler(async (req, res) => res.json(await get(req.tenant.workspaceId))));
router.put(
  '/sending-domain',
  validate({ params, body: Joi.object({ domain: Joi.string().trim().max(253).required(), localPart: localPart.default('orders') }) }),
  asyncHandler(async (req, res) => res.json(await add(req.tenant.workspaceId, req.body, req)))
);
router.patch('/sending-domain', validate({ params, body: Joi.object({ localPart: localPart.required() }) }), asyncHandler(async (req, res) => res.json(await setLocalPart(req.tenant.workspaceId, req.body.localPart, req))));
router.post('/sending-domain/verify', validate({ params }), asyncHandler(async (req, res) => res.json(await verify(req.tenant.workspaceId, req))));
router.delete('/sending-domain', validate({ params }), asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req))));

module.exports = { router, fromAddressFor, get, add, verify, remove };
