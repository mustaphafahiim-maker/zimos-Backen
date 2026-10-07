'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { NotFoundError, ConflictError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { lookupTxt } = require('./dnsVerifier');
const rules = require('./domainRules');

/**
 * Merchant custom domains: record one, then verify control of it via a DNS
 * TXT record on _zimos-verify.<host>. TLS is handled by the certificate
 * provider in front of the domain (certificates/), not here.
 *
 * A hostname belongs to a store only once verified (item 341, Ziad's
 * d051b79): the unique index covers verified and active rows only (migration
 * 211), so an unverified claim never blocks the real owner, and the first
 * store to verify removes the others' pending rows for that host.
 */

const USABLE = ['verified', 'active'];
const { normalizeHostname, txtRecordFor } = rules;

/** Rows that hold a hostname for `workspaceId`: verified anywhere, or any of its own. */
const holding = (workspaceId) => ({ [Op.or]: [{ status: USABLE }, { workspaceId }] });

/**
 * Whether `workspaceId` may connect `host` now; throws the error the
 * dashboard shows. Also run before a domain is bought (purchases.js), so
 * nothing is bought that could not then be connected.
 */
async function assertCanAdd(workspaceId, host) {
  // The store's own pending rows past their days (CUSTOM_DOMAINS_PENDING_TTL_DAYS) are gone for good.
  const cutoff = rules.pendingCutoff();
  if (cutoff) {
    await db.Domain.destroy({ where: { workspaceId, status: 'pending_verification', createdAt: { [Op.lt]: cutoff } } });
  }
  if (await db.Domain.findOne({ where: { workspaceId, hostname: host }, attributes: ['id'] })) {
    throw new ConflictError('That domain is already on this store', 'DOMAIN_ALREADY_ADDED');
  }
  if (await db.Domain.findOne({ where: { hostname: host, status: USABLE }, attributes: ['id'] })) {
    throw new ConflictError('That domain is already connected to a store', 'DOMAIN_TAKEN');
  }
  // CUSTOM_DOMAINS_MAX_PER_STORE, when set; the plan's own limit is a route gate (billing/planLimits.js).
  const max = env.customDomains.maxPerStore;
  if (max && (await db.Domain.count({ where: { workspaceId } })) >= max) {
    throw new ConflictError(`A store can connect up to ${max} domain${max === 1 ? '' : 's'}: remove one first`, 'DOMAIN_LIMIT_REACHED');
  }
}

async function addDomain(workspaceId, { hostname }, req) {
  const host = rules.checkHostname(hostname);

  const website = await db.Website.findOne({ where: { workspaceId }, order: [['createdAt', 'ASC']], attributes: ['id'] });
  if (!website) {
    throw new ConflictError('Set up your store (add a product) before connecting a domain', 'STORE_NOT_SET_UP');
  }
  await assertCanAdd(workspaceId, host);

  // www and the root are one address: the other one is sent here unless it is connected itself (rootDomains.js).
  // Another store's unverified claim does not count; with subdomains only, no root is ever sent here.
  const other = rules.subdomainsOnly() ? null : require('./rootDomains').counterpartOf(host);
  const otherTaken = other ? await db.Domain.count({ where: { hostname: other, ...holding(workspaceId) } }) : 0;

  let domain;
  try {
    domain = await db.Domain.create({
      workspaceId,
      websiteId: website.id,
      hostname: host,
      verificationToken: crypto.randomBytes(16).toString('hex'),
      status: 'pending_verification',
      counterpart: other && !otherTaken ? { redirect: true, sslStatus: 'none' } : null,
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError('That domain is already connected to a store', 'DOMAIN_TAKEN');
    }
    throw err;
  }

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.add',
    entityType: 'Domain',
    entityId: domain.id,
    after: { hostname: host },
    req,
  });

  return { domain, record: txtRecordFor(domain) };
}

async function listDomains(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
  const target = rules.cnameTarget(workspace);
  const domains = await db.Domain.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  return domains.map((d) => ({
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    verifiedAt: d.verifiedAt,
    record: txtRecordFor(d),
    // A root cannot take a CNAME: it points by A records or an ALIAS (rootDomains.js).
    cname: require('./rootDomains').isRoot(d.hostname) ? null : { type: 'CNAME', name: d.hostname, value: target },
    routing: require('./rootDomains').routingFor(d.hostname, target).records,
  }));
}

const flat = (chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks));

/** Whether `name` carries the TXT `expected`. NXDOMAIN / no TXT records count as "not found yet". */
async function hasTxt(name, expected) {
  const records = await lookupTxt(name).catch(() => []);
  return (records || []).some((chunks) => flat(chunks) === expected);
}

/** Marks a domain verified and removes the other stores' unverified claims to the host. */
async function markVerified(domain, extra = {}) {
  try {
    await db.sequelize.transaction(async (transaction) => {
      await domain.update({ status: 'verified', verifiedAt: new Date(), ...extra }, { transaction });
      // The host is this store's now: other stores' unverified claims go.
      await db.Domain.destroy({
        where: { hostname: domain.hostname, id: { [Op.ne]: domain.id }, status: 'pending_verification' },
        transaction,
      });
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      await domain.reload().catch(() => null);
      throw new ConflictError('That domain is already connected to a store', 'DOMAIN_TAKEN');
    }
    throw err;
  }
}

async function verifyDomain(workspaceId, domainId, req) {
  const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId } });
  if (!domain) throw new NotFoundError('Domain');
  if (USABLE.includes(domain.status)) {
    return { domain, verified: true };
  }
  if (rules.isExpiredPending(domain)) {
    throw new ConflictError(
      `This domain was not verified within ${env.customDomains.pendingTtlDays} days: remove it and add it again`,
      'DOMAIN_VERIFICATION_EXPIRED'
    );
  }

  const expected = rules.verificationValue(domain);
  const recordName = rules.verificationName(domain.hostname);
  // The record's name since item 341; a domain added before may still have it on the host itself.
  const found = (await hasTxt(recordName, expected)) || (await hasTxt(domain.hostname, expected));

  if (!found) {
    throw new AppError(
      'DOMAIN_NOT_VERIFIED',
      `No TXT record "${expected}" found on ${recordName} yet — add it at your DNS provider and try again`,
      400
    );
  }

  await markVerified(domain);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.verify',
    entityType: 'Domain',
    entityId: domain.id,
    after: { hostname: domain.hostname, status: 'verified' },
    req,
  });
  // The provider hears of the hostname only now that our TXT proved control.
  await require('./domainSettings').requestAfterVerify(domain);

  return { domain, verified: true };
}

/**
 * Removing a custom domain is a genuine hard delete: a Domain row only drives
 * host -> workspace routing (see hostResolver). Nothing in order or financial
 * history references it, so there's nothing to preserve by archiving.
 */
async function deleteDomain(workspaceId, domainId, req) {
  const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId } });
  if (!domain) throw new NotFoundError('Domain');
  const before = domain.toJSON();
  await require('./domainSettings').revokeCertificate(domain);
  await domain.destroy();
  // It may have been the store's canonical address (primaryHost.js).
  require('./primaryHost').forget(workspaceId);
  require('../storefront/storefrontCache').invalidate(workspaceId);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.delete',
    entityType: 'Domain',
    entityId: domainId,
    before,
    req,
  });

  return { deleted: true, id: domainId };
}

module.exports = { addDomain, assertCanAdd, markVerified, holding, listDomains, verifyDomain, deleteDomain, normalizeHostname };
