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
const primaryHost = require('./primaryHost');
const rootDomains = require('./rootDomains');

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

/** The counterpart (www / root) as the dashboard shows it, or null when the domain has none. */
function presentCounterpart(domain, target) {
  const hostname = rootDomains.counterpartOf(domain.hostname);
  if (!hostname) return null;
  const c = domain.counterpart || null;
  const routing = c && c.redirect ? rootDomains.routingFor(hostname, target, 'redirect') : { records: [], alternatives: [] };
  return {
    hostname,
    redirect: Boolean(c && c.redirect),
    sslStatus: c && SSL_STATUSES.includes(c.sslStatus) ? c.sslStatus : 'none',
    records: routing.records,
    alternatives: routing.alternatives,
  };
}

function present(domain, workspace, funnel) {
  const target = cnameTargetFor(workspace);
  // A root domain takes A records (or an ALIAS), a subdomain a CNAME (rootDomains.js).
  const routing = rootDomains.routingFor(domain.hostname, target);
  const counterpart = presentCounterpart(domain, target);
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
    isRoot: rootDomains.isRoot(domain.hostname),
    // The records the merchant creates at their DNS provider: the TXT, the
    // routing ones, and the counterpart's when it is sent here.
    records: [
      { type: 'TXT', name: domain.hostname, value: TXT_PREFIX + domain.verificationToken, ttl: 300, purpose: 'verification' },
      ...routing.records,
      ...(counterpart ? counterpart.records : []),
    ],
    // Instead of the routing records, where the DNS provider has it (a root's ALIAS / ANAME).
    alternatives: [...routing.alternatives, ...(counterpart ? counterpart.alternatives : [])],
    counterpart,
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
/** The store's canonical host may have changed: forget the remembered one and the store's cached info. */
function canonicalChanged(workspaceId) {
  primaryHost.forget(workspaceId);
  require('../storefront/storefrontCache').invalidate(workspaceId);
}

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
  const counterpartDetail = await syncCounterpartCertificate(domain, provider);
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
  return { domain: await presentOne(workspaceId, domain), detail: result.detail || counterpartDetail || null };
}

/**
 * The counterpart's certificate, beside the domain's: a visitor reaches it
 * over https before being sent on. A provider failure here leaves its state
 * as it was; it never fails the domain's own check.
 */
async function syncCounterpartCertificate(domain, provider) {
  const c = domain.counterpart;
  const hostname = rootDomains.counterpartOf(domain.hostname);
  if (!c || !c.redirect || !hostname) return null;
  try {
    const result =
      c.sslStatus === 'none' || !c.sslProviderRef
        ? await provider.requestCertificate({ hostname })
        : await provider.getStatus({ hostname, providerRef: c.sslProviderRef });
    await domain.update({
      counterpart: {
        ...c,
        sslStatus: SSL_STATUSES.includes(result.status) ? result.status : 'pending',
        sslProviderRef: result.providerRef || c.sslProviderRef || null,
        sslCheckedAt: new Date().toISOString(),
      },
    });
    return result.status === 'failed' ? result.detail || null : null;
  } catch (err) {
    if (err instanceof CertificateProviderError) return err.message;
    throw err;
  }
}

async function revokeCounterpart(domain) {
  const c = domain && domain.counterpart;
  const hostname = domain && rootDomains.counterpartOf(domain.hostname);
  if (!c || !hostname || !c.sslProviderRef) return;
  try {
    await getCertificateProvider().revoke({ hostname, providerRef: c.sslProviderRef });
  } catch {
    /* nothing to keep either way */
  }
}

/** Primary domain and home funnel. */
async function updateDomain(workspaceId, domainId, patch, req) {
  return db.sequelize.transaction(async (transaction) => {
    const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId }, transaction });
    if (!domain) throw new NotFoundError('Domain');
    const before = { isPrimary: domain.isPrimary, homeFunnelId: domain.homeFunnelId, counterpart: domain.counterpart };

    if (patch.isPrimary === true) {
      if (!USABLE.includes(domain.status)) {
        throw new ConflictError('Only a verified domain can be the primary one', 'DOMAIN_NOT_VERIFIED');
      }
      await db.Domain.update({ isPrimary: false }, { where: { workspaceId }, transaction });
      domain.isPrimary = true;
    } else if (patch.isPrimary === false) {
      domain.isPrimary = false;
    }

    if (patch.redirectCounterpart !== undefined) {
      const other = rootDomains.counterpartOf(domain.hostname);
      if (!other) throw new AppError('NO_COUNTERPART', 'Only a root domain or its www has a counterpart to send here', 422);
      if (patch.redirectCounterpart) {
        const taken = await db.Domain.count({ where: { hostname: other, status: USABLE }, transaction });
        if (taken) throw new ConflictError(`${other} is connected as a domain of its own`, 'COUNTERPART_CONNECTED');
        if (!(domain.counterpart && domain.counterpart.redirect)) domain.counterpart = { redirect: true, sslStatus: 'none' };
      } else if (domain.counterpart) {
        await revokeCounterpart(domain);
        domain.counterpart = null;
      }
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
      after: { isPrimary: domain.isPrimary, homeFunnelId: domain.homeFunnelId, counterpart: domain.counterpart },
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
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
  const expectedTxt = TXT_PREFIX + domain.verificationToken;
  const expectedCname = cnameTargetFor(workspace);

  const txt = await dns.promises.resolveTxt(domain.hostname).then(flatten, () => []);
  const cname = await dns.promises.resolveCname(domain.hostname).then((list) => list.map(bare), () => []);
  const other = domain.counterpart && domain.counterpart.redirect ? rootDomains.counterpartOf(domain.hostname) : null;

  return {
    hostname: domain.hostname,
    txt: { expected: expectedTxt, found: txt.includes(expectedTxt), values: txt.slice(0, 10) },
    cname: { expected: expectedCname, found: cname.includes(bare(expectedCname)), values: cname.slice(0, 10) },
    // The routing record, whichever kind this host takes (a root's A / ALIAS, a subdomain's CNAME).
    routing: await routingCheck(domain.hostname, expectedCname),
    counterpart: other ? { hostname: other, ...(await routingCheck(other, expectedCname)) } : null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Whether a host reaches the store: a subdomain by its CNAME; a root by its
 * addresses — the platform's (PLATFORM_APEX_IPS) or the platform subdomain's
 * own, which is what an ALIAS / flattened CNAME resolves to.
 */
async function routingCheck(hostname, target) {
  if (!rootDomains.isRoot(hostname)) {
    const values = await dns.promises.resolveCname(hostname).then((list) => list.map(bare), () => []);
    return { kind: 'CNAME', expected: [target], found: values.includes(bare(target)), values: values.slice(0, 10) };
  }
  const values = await dns.promises.resolve4(hostname).then((list) => list, () => []);
  const targetIps = await dns.promises.resolve4(target).then((list) => list, () => []);
  const allowed = new Set([...rootDomains.apexIps(), ...targetIps]);
  const ips = rootDomains.apexIps();
  return {
    kind: ips.length ? 'A' : 'ALIAS',
    expected: ips.length ? ips : [target],
    found: values.length > 0 && values.every((ip) => allowed.has(ip)),
    values: values.slice(0, 10),
  };
}

/** Tells the provider a removed domain's certificate is no longer wanted. Never throws. */
async function revokeCertificate(domain) {
  await revokeCounterpart(domain);
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
  if (!domain) {
    // www / the root of a domain that has it sent there (rootDomains.js): the proxy redirects.
    const sentTo = await counterpartTarget(host);
    if (sentTo) return sentTo;
    // A store's platform subdomain: only its primary domain is asked for, so the
    // storefront's proxy can send the shopper on to it.
    const platformSlug = primaryHost.platformSlugOf(host);
    const store = platformSlug
      ? await db.Workspace.findOne({ where: { slug: platformSlug, status: ['active', 'suspended'] }, attributes: ['id', 'slug'] })
      : null;
    if (!store && platformSlug) {
      // A store's previous address (workspaces/slugHistory.js): visitors go on to where it is now, same path.
      const formerId = await require('../workspaces/slugHistory').ownerOf(platformSlug);
      const moved = formerId ? await db.Workspace.findOne({ where: { id: formerId, status: ['active', 'suspended'] }, attributes: ['id', 'slug'] }) : null;
      if (moved) {
        const primary = await primaryHost.primaryHostOf(moved.id);
        const current = `${moved.slug}.${String(env.platformRootDomain).toLowerCase()}`;
        return { host, workspaceId: moved.id, slug: moved.slug, homeFunnel: null, primaryHost: primary, sslStatus: null, redirectTo: primary || current };
      }
    }
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
    primaryHost: await primaryHost.primaryHostOf(workspace.id),
    sslStatus: domain.sslStatus,
  };
}

/** resolve-host's answer for a domain's counterpart, or null when the host is none. */
async function counterpartTarget(host) {
  const of = rootDomains.counterpartOf(host);
  if (!of) return null;
  const domain = await db.Domain.findOne({ where: { hostname: of, status: USABLE } });
  if (!domain || !domain.counterpart || !domain.counterpart.redirect) return null;
  const workspace = await db.Workspace.findOne({ where: { id: domain.workspaceId, status: ['active', 'suspended'] }, attributes: ['id', 'slug'] });
  if (!workspace) return null;
  return {
    host,
    workspaceId: workspace.id,
    slug: workspace.slug,
    homeFunnel: null,
    primaryHost: await primaryHost.primaryHostOf(workspace.id),
    sslStatus: domain.counterpart.sslStatus || 'none',
    // Where a visit to this host goes, same path.
    redirectTo: domain.hostname,
  };
}

// --- routes -----------------------------------------------------------------

const uuid = Joi.string().uuid();
const domainParams = Joi.object({ workspaceId: uuid.required(), domainId: uuid.required() });
const schemas = {
  overview: { params: Joi.object({ workspaceId: uuid.required() }) },
  update: {
    params: domainParams,
    body: Joi.object({
      isPrimary: Joi.boolean().optional(),
      homeFunnelId: uuid.allow(null).optional(),
      // Send the www / root counterpart here (rootDomains.js).
      redirectCounterpart: Joi.boolean().optional(),
    }).min(1),
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
