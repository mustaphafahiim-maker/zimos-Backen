'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { registrar } = require('./registrar');

/*
 * Buy a domain in the dashboard (Lightfunnels' domain purchase; contract in
 * registrar/README.md): search a name, buy it, and the store is connected
 * to it with its DNS set by us; it renews itself unless switched off.
 *
 * Prices are the registrar's (never in this code). The merchant confirms the
 * price they were shown; a different quote at purchase time stops it.
 */

const TLDS = ['com', 'net', 'store', 'shop', 'online', 'co'];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RENEW_WINDOW_DAYS = 30;

const view = (p) => ({
  id: p.id,
  hostname: p.hostname,
  status: p.status,
  registrar: p.registrar,
  years: p.years,
  price: p.priceAmount === null ? null : { amount: p.priceAmount, currency: p.currency },
  autoRenew: p.autoRenew,
  expiresAt: p.expiresAt,
  lastRenewedAt: p.lastRenewedAt,
  lastError: p.lastError,
  domainId: p.domainId,
  createdAt: p.createdAt,
});

/** "My Store" / "mystore.com" → the names to check: the exact one, and the label on each usual TLD. */
function candidates(query) {
  const q = String(query || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const parts = q.split('.');
  const label = parts[0].normalize('NFKD').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!LABEL.test(label)) throw new AppError('VALIDATION_ERROR', 'Type a name with letters or digits', 422, [{ field: 'q', message: 'Type a name with letters or digits' }]);
  const exact = parts.length > 1 ? `${label}.${parts.slice(1).join('.')}` : null;
  return [...new Set([exact, ...TLDS.map((t) => `${label}.${t}`)].filter(Boolean))];
}

async function search(workspaceId, q) {
  const names = candidates(q);
  const owned = new Set((await db.Domain.findAll({ where: { hostname: names }, attributes: ['hostname'] })).map((d) => d.hostname));
  const results = await registrar().search(names);
  return { query: q, results: results.map((r) => ({ ...r, available: r.available && !owned.has(r.domain) })) };
}

async function list(workspaceId) {
  return { purchases: (await db.DomainPurchase.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] })).map(view) };
}

async function purchase(workspaceId, { domain, years, autoRenew, acceptPrice }, req) {
  const host = String(domain).trim().toLowerCase();
  if (!candidates(host).includes(host)) throw new AppError('VALIDATION_ERROR', 'Enter a full domain like mystore.com', 422, [{ field: 'domain', message: 'Enter a full domain like mystore.com' }]);
  const r = registrar();
  const [quote] = await r.search([host]);
  if (!quote || !quote.available || (await db.Domain.count({ where: { hostname: host } }))) throw new ConflictError('This domain is not available', 'DOMAIN_UNAVAILABLE');
  const sameAmount = (a, b) => (a === null && (b === null || b === undefined)) || (a && b && a.amount === b.amount && a.currency === b.currency);
  if (!sameAmount(quote.price, acceptPrice)) {
    throw new AppError('DOMAIN_PRICE_CHANGED', 'The price changed — check it and confirm again', 409, { price: quote.price });
  }

  const row = await db.DomainPurchase.create({
    workspaceId, hostname: host, registrar: r.name, status: 'pending', years, autoRenew,
    priceAmount: quote.price ? quote.price.amount : null, currency: quote.price ? quote.price.currency : null, createdBy: req.user.id,
  }).catch((err) => {
    if (err.name === 'SequelizeUniqueConstraintError') throw new ConflictError('This domain is already being bought', 'DOMAIN_UNAVAILABLE');
    throw err;
  });

  try {
    const contact = await db.User.findByPk(req.user.id, { attributes: ['fullName', 'email', 'phone'] });
    const reg = await r.register({ domain: host, years, contact: contact ? contact.toJSON() : {} });
    await row.update({ providerRef: reg.providerRef, expiresAt: reg.expiresAt });

    // Connect it to the store, then point its DNS here: we hold the zone, so it is verified at once.
    const domainsService = require('./domainsService');
    const { domain: added, record } = await domainsService.addDomain(workspaceId, { hostname: host }, req);
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
    const routing = require('./rootDomains').routingFor(host, `${workspace.slug}.${env.platformRootDomain}`);
    await r.setRecords({ domain: host, providerRef: reg.providerRef, records: [...routing.records, record] });
    await added.update({ status: 'verified', verifiedAt: new Date() });
    await row.update({ status: 'active', domainId: added.id, lastError: null });
  } catch (err) {
    await row.update({ status: 'failed', lastError: String(err.message).slice(0, 500) });
    logger.error('[domains] purchase failed', { workspaceId, domain: host, message: err.message });
    throw err.isOperational ? err : new AppError('DOMAIN_PURCHASE_FAILED', 'The domain could not be bought — nothing was charged', 502);
  } finally {
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'domain.purchase', entityType: 'DomainPurchase', entityId: row.id, after: { hostname: host, years, status: row.status, registrar: r.name }, req });
  }
  return { purchase: view(row) };
}

async function findOwn(workspaceId, id) {
  const row = await db.DomainPurchase.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Domain purchase');
  return row;
}

async function setAutoRenew(workspaceId, id, autoRenew, req) {
  const row = await findOwn(workspaceId, id);
  await row.update({ autoRenew });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'domain.auto_renew', entityType: 'DomainPurchase', entityId: row.id, after: { autoRenew }, req });
  return { purchase: view(row) };
}

async function renewRow(row, years) {
  const out = await registrar().renew({ domain: row.hostname, providerRef: row.providerRef, years, expiresAt: row.expiresAt });
  await row.update({ expiresAt: out.expiresAt, lastRenewedAt: new Date(), lastError: null, status: 'active' });
  return row;
}

async function renewNow(workspaceId, id, years, req) {
  const row = await findOwn(workspaceId, id);
  if (!['active', 'expired'].includes(row.status)) throw new ConflictError('Only a bought domain can be renewed', 'DOMAIN_NOT_ACTIVE');
  try {
    await renewRow(row, years);
  } catch (err) {
    await row.update({ lastError: String(err.message).slice(0, 500) });
    throw err;
  }
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'domain.renew', entityType: 'DomainPurchase', entityId: row.id, after: { years, expiresAt: row.expiresAt }, req });
  return { purchase: view(row) };
}

/** `domains.renew_due` (daily): renews auto-renew domains expiring within 30 days; marks lapsed ones expired. */
async function renewDue(now = new Date()) {
  const soon = new Date(now.getTime() + RENEW_WINDOW_DAYS * 864e5);
  const due = await db.DomainPurchase.findAll({ where: { status: 'active', autoRenew: true, expiresAt: { [Op.lte]: soon } }, limit: 200 });
  let renewed = 0;
  for (const row of due) {
    try {
      await renewRow(row, 1);
      renewed += 1;
    } catch (err) {
      await row.update({ lastError: String(err.message).slice(0, 500) });
      logger.error('[domains] auto-renew failed', { purchaseId: row.id, message: err.message });
    }
  }
  const [lapsed] = await db.DomainPurchase.update({ status: 'expired' }, { where: { status: 'active', expiresAt: { [Op.lt]: now } } });
  return { due: due.length, renewed, lapsed };
}

// ------------------------------------------------------------------ routes --

const params = Joi.object({ workspaceId: Joi.string().uuid().required() });
const withId = Joi.object({ workspaceId: Joi.string().uuid().required(), purchaseId: Joi.string().uuid().required() });
const money = Joi.object({ amount: Joi.number().integer().min(0).required(), currency: Joi.string().length(3).uppercase().required() });

/** Registers the routes on the domains router (domain.manage), before /:domainId. */
function mount(router) {
  router.get('/search', validate({ params, query: Joi.object({ q: Joi.string().trim().min(1).max(253).required() }) }), asyncHandler(async (req, res) => res.json(await search(req.tenant.workspaceId, req.query.q))));
  router.get('/purchases', validate({ params }), asyncHandler(async (req, res) => res.json(await list(req.tenant.workspaceId))));
  router.post(
    '/purchases',
    validate({ params, body: Joi.object({ domain: Joi.string().trim().max(253).required(), years: Joi.number().integer().min(1).max(10).default(1), autoRenew: Joi.boolean().default(true), acceptPrice: money.allow(null).required() }) }),
    requireLive,
    // A bought domain is a connected domain: the plan's number of custom domains applies (billing/planLimits.js).
    require('../billing/planLimits').requirePlanLimit('domains'),
    asyncHandler(async (req, res) => res.status(201).json(await purchase(req.tenant.workspaceId, req.body, req)))
  );
  router.patch('/purchases/:purchaseId', validate({ params: withId, body: Joi.object({ autoRenew: Joi.boolean().required() }) }), asyncHandler(async (req, res) => res.json(await setAutoRenew(req.tenant.workspaceId, req.params.purchaseId, req.body.autoRenew, req))));
  router.post('/purchases/:purchaseId/renew', validate({ params: withId, body: Joi.object({ years: Joi.number().integer().min(1).max(10).default(1) }) }), requireLive, asyncHandler(async (req, res) => res.json(await renewNow(req.tenant.workspaceId, req.params.purchaseId, req.body.years, req))));
}

module.exports = { mount, search, purchase, renewDue, candidates };
