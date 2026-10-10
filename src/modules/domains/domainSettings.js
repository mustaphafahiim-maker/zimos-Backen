'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { NotFoundError, ConflictError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getCertificateProvider, certificateProviderConfigured, CertificateProviderError } = require('./certificates');
const logger = require('../../core/utils/logger');
const primaryHost = require('./primaryHost');
const { domainDnsCheckLimiter } = require('../../core/middleware/rateLimiters');
const rules = require('./domainRules');
const { lookupTxt, lookupCname } = require('./dnsVerifier');

/**
 * What the domains screen needs beyond add / verify / delete (domainsService):
 * the full list with DNS instructions, the primary domain, the home funnel,
 * the certificate's state through a provider (certificates/README.md), a DNS
 * propagation check, and the public host lookup the storefront's proxy uses.
 */

// moved: the provider saw the merchant's CNAME stop pointing at us.
const SSL_STATUSES = ['none', 'pending', 'issued', 'failed', 'moved'];
const USABLE = ['verified', 'active'];

function present(domain, funnel) {
  const target = rules.cnameTarget();
  return {
    id: domain.id,
    hostname: domain.hostname,
    status: domain.status,
    verifiedAt: domain.verifiedAt,
    isPrimary: domain.isPrimary,
    redirectToPrimary: domain.redirectToPrimary !== false,
    sslStatus: SSL_STATUSES.includes(domain.sslStatus) ? domain.sslStatus : 'none',
    sslProvider: domain.sslProvider || null,
    sslCheckedAt: domain.sslCheckedAt || null,
    sslDetail: domain.sslDetail || null,
    suspended: Boolean(domain.suspendedAt),
    suspendedReason: domain.suspendedReason || null,
    homeFunnel: funnel ? { id: funnel.id, name: funnel.name, status: funnel.status } : null,
    // The two records the merchant creates at their DNS provider: the TXT on
    // its own name, since nothing else may sit beside a CNAME.
    records: [
      {
        type: 'TXT',
        name: rules.verificationName(domain.hostname),
        value: rules.verificationValue(domain),
        ttl: 300,
        purpose: 'verification',
      },
      { type: 'CNAME', name: domain.hostname, value: target, ttl: 300, purpose: 'routing' },
    ],
  };
}

async function loadDomain(workspaceId, domainId) {
  const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId } });
  if (!domain) throw new NotFoundError('Domain');
  return domain;
}

async function funnelsById(workspaceId, ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const rows = await db.Funnel.findAll({ where: { workspaceId, id: wanted }, attributes: ['id', 'name', 'status', 'subdomain'] });
  return new Map(rows.map((f) => [f.id, f]));
}

async function listDomains(workspaceId) {
  const domains = await db.Domain.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  const funnels = await funnelsById(workspaceId, domains.map((d) => d.homeFunnelId));
  return {
    domains: domains.map((d) => present(d, funnels.get(d.homeFunnelId))),
    cnameTarget: rules.cnameTarget(),
    maxPerStore: env.customDomains.maxPerStore,
    certificateProvider: (() => {
      try {
        return getCertificateProvider().code;
      } catch {
        return null;
      }
    })(),
  };
}

async function presentOne(workspaceId, domain) {
  const funnels = await funnelsById(workspaceId, [domain.homeFunnelId]);
  return present(domain, funnels.get(domain.homeFunnelId));
}

function providerFailure(err) {
  if (err instanceof CertificateProviderError) {
    return new AppError('CERTIFICATE_PROVIDER_ERROR', err.message, 502);
  }
  return err;
}

/**
 * Asks the provider for a certificate (first time) or where the request
 * stands. A domain that is not verified yet has nothing to certify.
 */
/** The store's canonical host may have changed: forget the remembered one and the store's cached info. */
function canonicalChanged(workspaceId) {
  primaryHost.forget(workspaceId);
  require('../storefront/storefrontCache').invalidate(workspaceId);
}

/**
 * Asks the provider for the hostname (the first time) or where it stands, and
 * stores the answer on the row. Only ever for a verified domain: the provider
 * hears of a hostname after our TXT proved the merchant controls it. Throws
 * CertificateProviderError. The merchant's button, the verification and the
 * domains job (jobs.js) all come through here.
 */
async function refreshCertificate(domain) {
  if (!USABLE.includes(domain.status)) {
    throw new ConflictError('Verify the domain before requesting its certificate', 'DOMAIN_NOT_VERIFIED');
  }
  const provider = getCertificateProvider();
  const first = domain.sslStatus === 'none' || !domain.sslProviderRef;
  let result;
  try {
    result = first
      ? await provider.requestCertificate({ hostname: domain.hostname })
      : await provider.getStatus({ hostname: domain.hostname, providerRef: domain.sslProviderRef });
  } catch (err) {
    // A first request that failed is recorded: the job's batch moves on to the
    // others, the merchant sees why, and the 72 hours also cover a request the
    // provider keeps refusing (domainJobs.js).
    if (first) {
      await domain.update({
        sslCheckedAt: new Date(),
        sslDetail: (err instanceof CertificateProviderError ? err.message : 'The certificate provider could not be reached').slice(0, 300),
        sslRequestedAt: domain.sslRequestedAt || new Date(),
      });
    }
    throw err;
  }
  const sslStatus = SSL_STATUSES.includes(result.status) ? result.status : 'pending';
  const now = new Date();
  await domain.update({
    sslStatus,
    sslProvider: provider.code,
    sslProviderRef: result.providerRef || domain.sslProviderRef,
    sslCheckedAt: now,
    sslDetail: result.detail ? String(result.detail).slice(0, 300) : null,
    // The job's 72 hours count from the request (migration 630).
    sslRequestedAt: first ? now : domain.sslRequestedAt || now,
    // A verified domain with a certificate is fully live.
    status: sslStatus === 'issued' ? 'active' : domain.status,
  });
  return result;
}

/**
 * Right after verification: ask for the certificate when a provider is set.
 * A failure here does not undo the verification; the domains job asks again
 * for every verified domain that has no certificate request yet.
 */
async function requestAfterVerify(domain) {
  if (!certificateProviderConfigured()) return;
  try {
    await refreshCertificate(domain);
    canonicalChanged(domain.workspaceId);
  } catch (err) {
    logger.warn('domains: certificate request after verification failed; the job retries', {
      domainId: domain.id,
      error: err.message,
    });
  }
}

async function syncCertificate(workspaceId, domainId, req) {
  const domain = await loadDomain(workspaceId, domainId);
  if (!USABLE.includes(domain.status)) {
    throw new ConflictError('Verify the domain before requesting its certificate', 'DOMAIN_NOT_VERIFIED');
  }
  const before = { sslStatus: domain.sslStatus, status: domain.status };
  let result;
  try {
    result = await refreshCertificate(domain);
  } catch (err) {
    throw providerFailure(err);
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.ssl_check',
    entityType: 'Domain',
    entityId: domain.id,
    before,
    after: { sslStatus: domain.sslStatus, status: domain.status },
    req,
  });
  canonicalChanged(workspaceId);
  return { domain: await presentOne(workspaceId, domain), detail: result.detail || null };
}

/** Primary domain, home funnel and whether visits go on to the primary domain. */
async function updateDomain(workspaceId, domainId, patch, req) {
  return db.sequelize.transaction(async (transaction) => {
    const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId }, transaction });
    if (!domain) throw new NotFoundError('Domain');
    const before = { isPrimary: domain.isPrimary, homeFunnelId: domain.homeFunnelId, redirectToPrimary: domain.redirectToPrimary };

    if (patch.isPrimary === true) {
      if (!USABLE.includes(domain.status)) {
        throw new ConflictError('Only a verified domain can be the primary one', 'DOMAIN_NOT_VERIFIED');
      }
      await db.Domain.update({ isPrimary: false }, { where: { workspaceId }, transaction });
      domain.isPrimary = true;
    } else if (patch.isPrimary === false) {
      domain.isPrimary = false;
    }

    if (patch.homeFunnelId !== undefined) {
      if (patch.homeFunnelId === null) {
        domain.homeFunnelId = null;
      } else {
        const funnel = await db.Funnel.findOne({
          where: { id: patch.homeFunnelId, workspaceId },
          attributes: ['id', 'status'],
          transaction,
        });
        if (!funnel) throw new NotFoundError('Funnel');
        if (funnel.status !== 'published') {
          throw new ConflictError('Publish the funnel before making it the home of a domain', 'FUNNEL_NOT_PUBLISHED');
        }
        domain.homeFunnelId = funnel.id;
      }
    }

    if (patch.redirectToPrimary !== undefined) domain.redirectToPrimary = patch.redirectToPrimary;

    await domain.save({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'domain.update',
      entityType: 'Domain',
      entityId: domain.id,
      before,
      after: { isPrimary: domain.isPrimary, homeFunnelId: domain.homeFunnelId, redirectToPrimary: domain.redirectToPrimary },
      req,
      transaction,
    });
    return domain;
  }).then((domain) => {
    canonicalChanged(workspaceId);
    return presentOne(workspaceId, domain);
  });
}

const flatten = (records) => (records || []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
const bare = (host) => String(host || '').toLowerCase().replace(/\.$/, '');

/**
 * Looks the two records up right now, so the merchant can see which one has
 * not propagated yet. Never throws for a missing record: that is the answer.
 */
async function checkDns(workspaceId, domainId) {
  const domain = await loadDomain(workspaceId, domainId);
  const txtName = rules.verificationName(domain.hostname);
  const expectedTxt = rules.verificationValue(domain);
  const expectedCname = rules.cnameTarget();

  // Public resolvers (dnsVerifier.js), so an internal name never answers.
  const txt = await lookupTxt(txtName).then(flatten, () => []);
  const cname = await lookupCname(domain.hostname).then((list) => list.map(bare), () => []);

  return {
    hostname: domain.hostname,
    txt: { name: txtName, expected: expectedTxt, found: txt.includes(expectedTxt), values: txt.slice(0, 10) },
    cname: { expected: expectedCname, found: cname.includes(bare(expectedCname)), values: cname.slice(0, 10) },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Tells the provider a removed domain's hostname is no longer wanted, once
 * the row is gone. Deleting the row already queued it as a
 * DomainProviderDeletion (migration 214's trigger); done here, that row goes
 * too. This never throws: a failure leaves the row for the domains job to
 * retry (jobs.js), so the hostname is not left behind at the provider.
 */
async function revokeCertificate(domain) {
  if (!domain || !domain.sslProviderRef) return;
  try {
    await getCertificateProvider().revoke({ hostname: domain.hostname, providerRef: domain.sslProviderRef });
  } catch (err) {
    await rememberDeletion(domain, err);
    return;
  }
  await db.DomainProviderDeletion.destroy({ where: { provider: providerOf(domain), providerRef: domain.sslProviderRef } });
}

const RETRY_AFTER_MS = 5 * 60 * 1000;

// The provider a queued deletion is kept under; the same as migration 214's trigger.
const providerOf = (domain) => String(domain.sslProvider || '').trim() || 'cloudflare';

async function rememberDeletion(domain, err) {
  const fields = {
    workspaceId: domain.workspaceId,
    hostname: domain.hostname,
    provider: providerOf(domain),
    providerRef: domain.sslProviderRef,
  };
  const lastError = String((err && err.message) || 'unknown error').slice(0, 500);
  const [row, created] = await db.DomainProviderDeletion.findOrCreate({
    where: { provider: fields.provider, providerRef: fields.providerRef },
    defaults: { ...fields, attempts: 1, lastError, nextAttemptAt: new Date(Date.now() + RETRY_AFTER_MS) },
  });
  if (!created) {
    await row.update({ attempts: row.attempts + 1, lastError, nextAttemptAt: new Date(Date.now() + RETRY_AFTER_MS) });
  }
  logger.warn('domains: provider deletion failed; kept for the retry job', { hostname: domain.hostname, error: lastError });
}

/**
 * Public: which store (and which funnel on its root) a host belongs to. Only
 * verified domains answer; anything else is a 404 so the storefront's proxy
 * can treat the host as unknown. Used by apps/storefront/src/proxy.ts.
 */
async function resolveHost(rawHost) {
  const host = bare(String(rawHost || '').split(':')[0]);
  if (!host) throw new NotFoundError('Host');
  // A suspended domain (store suspended, plan without custom_domain) is not served.
  const domain = await db.Domain.findOne({ where: { hostname: host, status: USABLE, suspendedAt: null } });
  if (!domain) {
    // A store's platform subdomain: only its primary domain is asked for, so the
    // storefront's proxy can send the shopper on to it.
    const platformSlug = primaryHost.platformSlugOf(host);
    const store = platformSlug
      ? await db.Workspace.findOne({ where: { slug: platformSlug, status: ['active', 'suspended'] }, attributes: ['id', 'slug'] })
      : null;
    if (!store) throw new NotFoundError('Host');
    return { host, workspaceId: store.id, slug: store.slug, homeFunnel: null, primaryHost: await primaryHost.primaryHostOf(store.id), sslStatus: null };
  }
  const workspace = await db.Workspace.findOne({
    where: { id: domain.workspaceId, status: ['active', 'suspended'] },
    attributes: ['id', 'slug'],
  });
  if (!workspace) throw new NotFoundError('Host');

  let homeFunnel = null;
  if (domain.homeFunnelId) {
    const funnel = await db.Funnel.findOne({
      where: { id: domain.homeFunnelId, workspaceId: workspace.id, status: 'published' },
      attributes: ['id', 'subdomain'],
    });
    if (funnel) homeFunnel = { id: funnel.id, ref: funnel.subdomain || funnel.id };
  }

  return {
    host,
    workspaceId: workspace.id,
    slug: workspace.slug,
    homeFunnel,
    // The store's canonical host (primaryHost.js): only a primary domain with a certificate.
    // A domain set not to redirect answers none, so the proxy serves the store here.
    primaryHost: domain.redirectToPrimary === false ? null : await primaryHost.primaryHostOf(workspace.id),
    redirectToPrimary: domain.redirectToPrimary !== false,
    sslStatus: domain.sslStatus,
  };
}

// --- routes -----------------------------------------------------------------

const uuid = Joi.string().uuid();
const domainParams = Joi.object({ workspaceId: uuid.required(), domainId: uuid.required() });
const schemas = {
  overview: { params: Joi.object({ workspaceId: uuid.required() }) },
  update: {
    params: domainParams,
    body: Joi.object({ isPrimary: Joi.boolean().optional(), homeFunnelId: uuid.allow(null).optional(), redirectToPrimary: Joi.boolean().optional() }).min(1),
  },
  one: { params: domainParams },
  resolveHost: { query: Joi.object({ host: Joi.string().trim().max(255).required() }) },
};

/** Added to the staff router of domainsRoutes.js (already behind domain.manage). */
function mountStaffRoutes(router) {
  router.get(
    '/overview',
    validate(schemas.overview),
    asyncHandler(async (req, res) => res.json(await listDomains(req.tenant.workspaceId)))
  );
  router.patch(
    '/:domainId',
    validate(schemas.update),
    asyncHandler(async (req, res) =>
      res.json({ domain: await updateDomain(req.tenant.workspaceId, req.params.domainId, req.body, req) })
    )
  );
  router.post(
    '/:domainId/ssl/check',
    validate(schemas.one),
    asyncHandler(async (req, res) => res.json(await syncCertificate(req.tenant.workspaceId, req.params.domainId, req)))
  );
  router.get(
    '/:domainId/dns-check',
    domainDnsCheckLimiter,
    validate(schemas.one),
    asyncHandler(async (req, res) => res.json({ dns: await checkDns(req.tenant.workspaceId, req.params.domainId) }))
  );
}

// Mounted at /api/v1/store/resolve-host — public, read by the storefront proxy.
const publicRouter = Router();
publicRouter.get(
  '/',
  validate(schemas.resolveHost),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ store: await resolveHost(req.query.host) });
  })
);

module.exports = {
  SSL_STATUSES,
  listDomains,
  updateDomain,
  syncCertificate,
  refreshCertificate,
  requestAfterVerify,
  rememberDeletion,
  checkDns,
  revokeCertificate,
  resolveHost,
  mountStaffRoutes,
  publicRouter,
};
