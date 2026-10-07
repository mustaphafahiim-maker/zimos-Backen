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
 * The scheduled work behind custom domains (jobs.js; item 341, Ziad's
 * 045801f). Each run takes a bounded batch, and one domain's failure never
 * stops the others.
 *
 * While CUSTOM_DOMAINS_ENABLED closes custom domains, everything but the
 * provider deletion retry does nothing. The certificate jobs need a provider
 * (CERTIFICATE_PROVIDER; the sandbox outside production) too.
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
 * not issued 72 hours after the request, it is failed with a reason the
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
    // The 72 hours count from the provider request (migration 505), not from the
    // verification: a domain verified before a provider was set up gets its full time.
    // A first request the provider kept refusing ('none', its attempts recorded by
    // refreshCertificate) runs out the same way, with the provider's last answer.
    const since = domain.sslRequestedAt ? new Date(domain.sslRequestedAt).getTime() : null;
    if (since !== null && now - since > CERTIFICATE_DEADLINE_MS) {
      const neverRequested = domain.sslStatus === 'none' && domain.sslDetail;
      await domain.update({
        sslStatus: 'failed',
        sslCheckedAt: new Date(now),
        // A root domain points by A records or an ALIAS, not a CNAME (rootDomains.js).
        sslDetail: neverRequested
          ? `The certificate could not be requested within 72 hours: ${domain.sslDetail}`.slice(0, 300)
          : 'The certificate was not issued within 72 hours: check that the DNS records point at the store',
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

/**
 * Hourly: pending rows past their days (never verified, never at the
 * provider). Only with CUSTOM_DOMAINS_PENDING_TTL_DAYS set; unset, an
 * unverified domain waits for its TXT however long it takes, as before.
 */
async function removeExpiredPending(now = Date.now()) {
  const cutoff = pendingCutoff(now);
  if (!enabled() || !cutoff) return { removed: 0 };
  const removed = await db.Domain.destroy({
    where: { status: 'pending_verification', createdAt: { [Op.lt]: cutoff } },
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
 * whose plan lost custom_domain (PLAN_FEATURE_ENFORCEMENT on), is suspended,
 * never deleted, and served again once the reason is gone. A plan suspension
 * is not served at all; a store suspension still shows the store's own
 * "unavailable" page there, as it does on every host of a suspended store
 * (domainSettings.resolveHost); neither is the store's canonical address.
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
