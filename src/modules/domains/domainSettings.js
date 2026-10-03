'use strict';

const dns = require('dns');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { NotFoundError, ConflictError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getCertificateProvider, CertificateProviderError } = require('./certificates');

/**
 * What the domains screen needs beyond add / verify / delete (domainsService):
 * the full list with DNS instructions, the primary domain, the home funnel,
 * the certificate's state through a provider (certificates/README.md), a DNS
 * propagation check, and the public host lookup the storefront's proxy uses.
 */

const SSL_STATUSES = ['none', 'pending', 'issued', 'failed'];
const TXT_PREFIX = 'zimos-verify=';
const USABLE = ['verified', 'active'];

/** Where a merchant points their domain: the store's own platform subdomain. */
const cnameTargetFor = (workspace) => `${workspace.slug}.${env.platformRootDomain}`;

function present(domain, workspace, funnel) {
  const target = cnameTargetFor(workspace);
  return {
    id: domain.id,
    hostname: domain.hostname,
    status: domain.status,
    verifiedAt: domain.verifiedAt,
    isPrimary: domain.isPrimary,
    sslStatus: SSL_STATUSES.includes(domain.sslStatus) ? domain.sslStatus : 'none',
    sslProvider: domain.sslProvider || null,
    sslCheckedAt: domain.sslCheckedAt || null,
    homeFunnel: funnel ? { id: funnel.id, name: funnel.name, status: funnel.status } : null,
    // The two records the merchant creates at their DNS provider.
    records: [
      { type: 'TXT', name: domain.hostname, value: TXT_PREFIX + domain.verificationToken, ttl: 300, purpose: 'verification' },
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
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
  const domains = await db.Domain.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  const funnels = await funnelsById(workspaceId, domains.map((d) => d.homeFunnelId));
  return {
    domains: domains.map((d) => present(d, workspace, funnels.get(d.homeFunnelId))),
    cnameTarget: cnameTargetFor(workspace),
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
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
  const funnels = await funnelsById(workspaceId, [domain.homeFunnelId]);
  return present(domain, workspace, funnels.get(domain.homeFunnelId));
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
async function syncCertificate(workspaceId, domainId, req) {
  const domain = await loadDomain(workspaceId, domainId);
  if (!USABLE.includes(domain.status)) {
    throw new ConflictError('Verify the domain before requesting its certificate', 'DOMAIN_NOT_VERIFIED');
  }
  const before = { sslStatus: domain.sslStatus, status: domain.status };
  let result;
  let provider;
  try {
    provider = getCertificateProvider();
    result =
      domain.sslStatus === 'none' || !domain.sslProviderRef
        ? await provider.requestCertificate({ hostname: domain.hostname })
        : await provider.getStatus({ hostname: domain.hostname, providerRef: domain.sslProviderRef });
  } catch (err) {
    throw providerFailure(err);
  }

  await domain.update({
    sslStatus: SSL_STATUSES.includes(result.status) ? result.status : 'pending',
    sslProvider: provider.code,
    sslProviderRef: result.providerRef || domain.sslProviderRef,
    sslCheckedAt: new Date(),
    // A verified domain with a certificate is fully live.
    status: result.status === 'issued' ? 'active' : domain.status,
  });
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
  return { domain: await presentOne(workspaceId, domain), detail: result.detail || null };
}

/** Primary domain and home funnel. */
async function updateDomain(workspaceId, domainId, patch, req) {
  return db.sequelize.transaction(async (transaction) => {
    const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId }, transaction });
    if (!domain) throw new NotFoundError('Domain');
    const before = { isPrimary: domain.isPrimary, homeFunnelId: domain.homeFunnelId };

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

    await domain.save({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'domain.update',
      entityType: 'Domain',
      entityId: domain.id,
      before,
      after: { isPrimary: domain.isPrimary, homeFunnelId: domain.homeFunnelId },
      req,
      transaction,
    });
    return domain;
  }).then((domain) => presentOne(workspaceId, domain));
}

const flatten = (records) => (records || []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
const bare = (host) => String(host || '').toLowerCase().replace(/\.$/, '');

/**
 * Looks the two records up right now, so the merchant can see which one has
 * not propagated yet. Never throws for a missing record: that is the answer.
 */
async function checkDns(workspaceId, domainId) {
  const domain = await loadDomain(workspaceId, domainId);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
  const expectedTxt = TXT_PREFIX + domain.verificationToken;
  const expectedCname = cnameTargetFor(workspace);

  const txt = await dns.promises.resolveTxt(domain.hostname).then(flatten, () => []);
  const cname = await dns.promises.resolveCname(domain.hostname).then((list) => list.map(bare), () => []);

  return {
    hostname: domain.hostname,
    txt: { expected: expectedTxt, found: txt.includes(expectedTxt), values: txt.slice(0, 10) },
    cname: { expected: expectedCname, found: cname.includes(bare(expectedCname)), values: cname.slice(0, 10) },
    checkedAt: new Date().toISOString(),
  };
}

/** Tells the provider a removed domain's certificate is no longer wanted. Never throws. */
async function revokeCertificate(domain) {
  if (!domain || domain.sslStatus === 'none' || !domain.sslProviderRef) return;
  try {
    await getCertificateProvider().revoke({ hostname: domain.hostname, providerRef: domain.sslProviderRef });
  } catch {
    /* the row is going away either way */
  }
}

/**
 * Public: which store (and which funnel on its root) a host belongs to. Only
 * verified domains answer; anything else is a 404 so the storefront's proxy
 * can treat the host as unknown. Used by apps/storefront/src/proxy.ts.
 */
async function resolveHost(rawHost) {
  const host = bare(String(rawHost || '').split(':')[0]);
  if (!host) throw new NotFoundError('Host');
  const domain = await db.Domain.findOne({ where: { hostname: host, status: USABLE } });
  if (!domain) throw new NotFoundError('Host');
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
  const primary = domain.isPrimary
    ? domain
    : await db.Domain.findOne({ where: { workspaceId: workspace.id, isPrimary: true, status: USABLE }, attributes: ['hostname'] });

  return {
    host,
    workspaceId: workspace.id,
    slug: workspace.slug,
    homeFunnel,
    primaryHost: primary ? primary.hostname : null,
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
    body: Joi.object({ isPrimary: Joi.boolean().optional(), homeFunnelId: uuid.allow(null).optional() }).min(1),
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
  checkDns,
  revokeCertificate,
  resolveHost,
  mountStaffRoutes,
  publicRouter,
};
