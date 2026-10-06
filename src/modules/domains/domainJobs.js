'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const entitlements = require('../billing/entitlementsService');
const { getCertificateProvider, certificateProviderConfigured } = require('./certificates');
const { refreshCertificate } = require('./domainSettings');
const { pendingCutoff } = require('./domainRules');

/**
 * The scheduled work behind custom domains (jobs.js). Each run takes a
 * bounded batch, and one domain's failure never stops the others.
 *
 * While CUSTOM_DOMAINS_ENABLED is off, everything but the provider deletion
 * retry does nothing, as before these jobs existed. The certificate jobs need
 * a provider (CERTIFICATE_PROVIDER) too.
 */

const BATCH = 100;
const CERTIFICATE_DEADLINE_MS = 72 * 60 * 60 * 1000;
const USABLE = ['verified', 'active'];
const enabled = () => env.customDomains.enabled === true;

function forgetStore(workspaceId) {
  require('./primaryHost').forget(workspaceId);
  require('../storefront/storefrontCache').invalidate(workspaceId);
}

async function each(rows, fn) {
  let failed = 0;
  for (const row of rows) {
    try {
      await fn(row);
    } catch (err) {
      failed += 1;
      logger.warn('domains job: one domain failed', { domainId: row.id, error: err.message });
    }
  }
  return { checked: rows.length, failed };
}

/**
 * Every 5 minutes: verified domains with no certificate yet. A first request
 * that failed is made again; a pending one is asked where it stands; still
 * not issued 72 hours after verification, it is failed with a reason the
 * merchant can act on.
 */
async function pollPendingCertificates(now = Date.now()) {
  if (!enabled() || !certificateProviderConfigured()) return { checked: 0, failed: 0 };
  const rows = await db.Domain.findAll({
    where: { status: USABLE, sslStatus: ['none', 'pending'], suspendedAt: null },
    order: [['sslCheckedAt', 'ASC NULLS FIRST']],
    limit: BATCH,
  });
  return each(rows, async (domain) => {
    const since = new Date(domain.verifiedAt || domain.createdAt).getTime();
    if (now - since > CERTIFICATE_DEADLINE_MS) {
      await domain.update({
        sslStatus: 'failed',
        sslCheckedAt: new Date(now),
        sslDetail: 'The certificate was not issued within 72 hours: check that the CNAME record points at us',
      });
    } else {
      await refreshCertificate(domain);
    }
    forgetStore(domain.workspaceId);
  });
}

/** Daily: issued domains, to notice one the merchant pointed elsewhere (moved). */
async function checkActiveCertificates() {
  if (!enabled() || !certificateProviderConfigured()) return { checked: 0, failed: 0 };
  const rows = await db.Domain.findAll({
    where: { status: 'active', sslStatus: 'issued', sslProviderRef: { [Op.ne]: null } },
    order: [['sslCheckedAt', 'ASC NULLS FIRST']],
    limit: BATCH * 5,
  });
  return each(rows, async (domain) => {
    await refreshCertificate(domain);
    if (domain.sslStatus !== 'issued') forgetStore(domain.workspaceId);
  });
}

/**
 * Every 15 minutes: hostnames still to remove at the provider. Done (or 404
 * at the provider) removes the row; a failure waits longer each time, up to
 * 6 hours.
 */
async function retryProviderDeletions(now = Date.now()) {
  if (!certificateProviderConfigured()) return { checked: 0, failed: 0 };
  const rows = await db.DomainProviderDeletion.findAll({
    where: { nextAttemptAt: { [Op.lte]: new Date(now) } },
    order: [['nextAttemptAt', 'ASC']],
    limit: BATCH,
  });
  const provider = getCertificateProvider();
  let failed = 0;
  for (const row of rows) {
    if (row.provider !== provider.code) continue;
    try {
      await provider.revoke({ hostname: row.hostname, providerRef: row.providerRef });
      await row.destroy();
    } catch (err) {
      failed += 1;
      const attempts = row.attempts + 1;
      const waitMs = Math.min(attempts * 15 * 60 * 1000, 6 * 60 * 60 * 1000);
      await row.update({ attempts, lastError: String(err.message || 'unknown error').slice(0, 500), nextAttemptAt: new Date(now + waitMs) });
    }
  }
  return { checked: rows.length, failed };
}

/** Hourly: pending rows past their 7 days (never verified, never at the provider). */
async function removeExpiredPending(now = Date.now()) {
  if (!enabled()) return { removed: 0 };
  const removed = await db.Domain.destroy({
    where: { status: 'pending_verification', createdAt: { [Op.lt]: pendingCutoff(now) } },
  });
  return { removed };
}

/** Why a store's domains should not be served now, or null. */
async function suspensionReason(workspace) {
  if (!workspace || workspace.status === 'suspended') return 'store_suspended';
  if (env.planFeatures.enforcement && !(await entitlements.hasFeature(workspace.id, 'custom_domain'))) return 'plan';
  return null;
}

/**
 * Every 10 minutes: a verified domain of a suspended store, or of a store
 * whose plan lost custom_domain (PLAN_FEATURE_ENFORCEMENT on), stops being
 * served; it is suspended, never deleted, and served again once the reason
 * is gone.
 */
async function enforceAccess(now = Date.now()) {
  if (!enabled()) return { suspended: 0, restored: 0 };
  const domains = await db.Domain.findAll({ where: { status: USABLE }, attributes: ['id', 'workspaceId', 'suspendedAt', 'suspendedReason'] });
  const storeIds = [...new Set(domains.map((d) => d.workspaceId))];
  const stores = await db.Workspace.findAll({ where: { id: storeIds }, attributes: ['id', 'status'] });
  const byId = new Map(stores.map((w) => [w.id, w]));
  const reasons = new Map();
  for (const id of storeIds) reasons.set(id, await suspensionReason(byId.get(id)));

  let suspended = 0;
  let restored = 0;
  for (const domain of domains) {
    const reason = reasons.get(domain.workspaceId);
    if (reason && domain.suspendedReason !== reason) {
      await domain.update({ suspendedAt: domain.suspendedAt || new Date(now), suspendedReason: reason });
      suspended += 1;
      forgetStore(domain.workspaceId);
    } else if (!reason && domain.suspendedAt) {
      await domain.update({ suspendedAt: null, suspendedReason: null });
      restored += 1;
      forgetStore(domain.workspaceId);
    }
  }
  return { suspended, restored };
}

module.exports = {
  CERTIFICATE_DEADLINE_MS,
  pollPendingCertificates,
  checkActiveCertificates,
  retryProviderDeletions,
  removeExpiredPending,
  enforceAccess,
};
