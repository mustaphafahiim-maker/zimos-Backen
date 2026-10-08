'use strict';

const net = require('net');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { createUserLimiter } = require('../../core/middleware/rateLimiters');
const { verifyPassword } = require('../../core/security/password');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { registrar } = require('./registrar');
const rules = require('./domainRules');
const rootDomains = require('./rootDomains');

/*
 * DNS records and transfer-out for a domain bought here (spec-gaps item 385;
 * registrar/README.md "DNS records and transfer-out").
 *
 * We hold the domain's zone at the registrar. While the domain is connected
 * to the store, ZIMOS's records are locked: the routing records (the root's A
 * / ALIAS, the www CNAME when www is sent to the domain) and the verification
 * TXT on _zimos-verify.<domain>. Everything else is the merchant's: A, AAAA,
 * CNAME, MX (with priority) and TXT, up to 50. The registrars replace the
 * whole zone on every write, so a save always writes ours + the merchant's.
 *
 * Transfer-out: the store owner (password confirmed) unlocks the domain and
 * gets its transfer (EPP) code in that one answer. The code is never stored
 * or logged; auto-renew is switched off, since the domain is leaving.
 */

const EDITABLE = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const MAX_RECORDS = 50;
const ROUTING_TYPES = new Set(['A', 'AAAA', 'ALIAS', 'CNAME']);
const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;
const SENDING_KEY = 'email_sending_domain';

const DNS_UNSUPPORTED = ['DOMAIN_DNS_UNSUPPORTED', "Editing this domain's DNS records is not available with the current registrar"];
const TRANSFER_UNSUPPORTED = ['DOMAIN_TRANSFER_UNSUPPORTED', 'Getting the transfer code is not available with the current registrar — contact support'];

const lower = (v) => String(v || '').trim().toLowerCase().replace(/\.$/, '');

/** A record as we compare and show it: upper-case type, full lower-case name, host names without the final dot. */
function normalize(r) {
  const type = String(r.type || '').toUpperCase();
  const value = ['CNAME', 'MX', 'ALIAS'].includes(type) ? lower(r.value) : String(r.value ?? '');
  const out = { type, name: lower(r.name), value, ttl: Number(r.ttl) || 300 };
  if (type === 'MX') out.priority = Number.isInteger(Number(r.priority)) ? Number(r.priority) : 10;
  if (r.purpose) out.purpose = r.purpose;
  return out;
}

const keyOf = (r) => `${r.type}|${r.name}|${r.value}|${r.type === 'MX' ? r.priority : ''}`;
const hostOf = (name, domain) => (name === domain ? '@' : name.endsWith(`.${domain}`) ? name.slice(0, -(domain.length + 1)) : name);

/** ZIMOS's own records for a bought domain while it is connected to the store; [] once it is not. */
async function zimosRecords(row) {
  if (!row.domainId) return [];
  const domain = await db.Domain.findOne({ where: { id: row.domainId, workspaceId: row.workspaceId } });
  if (!domain) return [];
  const workspace = await db.Workspace.findByPk(row.workspaceId, { attributes: ['id', 'slug'] });
  const target = rules.cnameTarget(workspace);
  const out = [];
  if (target) {
    out.push(...rootDomains.routingFor(row.hostname, target).records);
    const other = rootDomains.counterpartOf(row.hostname);
    if (other && domain.counterpart && domain.counterpart.redirect && domain.counterpart.dnsManaged) out.push(...rootDomains.routingFor(other, target, 'redirect').records);
  }
  out.push({ ...rules.txtRecordFor(domain), ttl: 300, purpose: 'verification' });
  return out.map(normalize);
}

/**
 * The names ZIMOS's records hold: a CNAME's or a TXT's name holds the whole name
 * (nothing may sit beside a CNAME; _zimos-verify.<domain> is ours), a routed
 * name (the root's A / ALIAS) only its address records.
 */
function reservation(ours) {
  const whole = new Set();
  const routed = new Set();
  for (const r of ours) {
    if (r.type === 'CNAME' || r.type === 'TXT') whole.add(r.name);
    else routed.add(r.name);
  }
  return {
    whole,
    routed,
    isReserved: (r) => whole.has(r.name) || (routed.has(r.name) && ROUTING_TYPES.has(r.type)),
    blocks: (r) => whole.has(r.name) || (routed.has(r.name) && ROUTING_TYPES.has(r.type)) || (r.type === 'CNAME' && routed.has(r.name)),
  };
}

/** The store's sending-domain records (emailDomains/sendingDomain.js) that sit inside `host`, as records to write. */
async function sendingRecords(workspaceId, host) {
  const ws = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const s = ws && ws.settings && ws.settings[SENDING_KEY];
  if (!s || !s.domain || !Array.isArray(s.records)) return [];
  if (s.domain !== host && !s.domain.endsWith(`.${host}`)) return [];
  return s.records
    .filter((r) => ['TXT', 'CNAME', 'MX'].includes(String(r.type).toUpperCase()))
    .map((r) => ({ ...normalize({ type: r.type, name: r.name, value: r.value, priority: r.priority }), purpose: r.purpose || null }))
    .filter((r) => r.name === host || r.name.endsWith(`.${host}`));
}

/** The sending-domain records a new purchase adds beside ours (item 385); none that would clash with ours. */
async function sendingRecordsFor(workspaceId, host, ours) {
  const res = reservation(ours.map(normalize));
  return (await sendingRecords(workspaceId, host)).filter((r) => !res.blocks(r)).map(({ purpose, ...r }) => r);
}

async function findPurchase(workspaceId, id) {
  const row = await db.DomainPurchase.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Domain purchase');
  return row;
}

/** The registrar that holds the purchase, with `needs` implemented; else the error the dashboard shows. */
function holder(row, needs, unsupported) {
  if (row.status !== 'active' || !row.providerRef) throw new ConflictError('This works only for a bought, active domain', 'DOMAIN_NOT_ACTIVE');
  const r = registrar();
  if (r.name !== row.registrar) throw new AppError('DOMAIN_REGISTRAR_CHANGED', `This domain is held at ${row.registrar}, which the platform no longer uses — contact support`, 409);
  if (needs.some((n) => typeof r[n] !== 'function')) throw new AppError(unsupported[0], unsupported[1], 501);
  return r;
}

/** What the dashboard may offer on a purchase row (GET /purchases). */
function capabilities(row) {
  try {
    const r = registrar();
    const here = row.status === 'active' && Boolean(row.providerRef) && r.name === row.registrar;
    return { dnsRecords: here && typeof r.getRecords === 'function', transferCode: here && typeof r.unlock === 'function' && typeof r.authCode === 'function' };
  } catch {
    return { dnsRecords: false, transferCode: false };
  }
}

async function readZone(r, row) {
  const zone = await r.getRecords({ domain: row.hostname, providerRef: row.providerRef });
  return (zone || []).map(normalize);
}

function present(row, records, extra = {}) {
  return {
    hostname: row.hostname,
    registrar: row.registrar,
    records: records.map((r) => ({
      type: r.type,
      name: r.name,
      host: hostOf(r.name, row.hostname),
      value: r.value,
      ...(r.type === 'MX' ? { priority: r.priority } : {}),
      ttl: r.ttl,
      locked: Boolean(r.locked),
      purpose: r.purpose || null,
      ...(r.locked ? { present: r.present !== false } : { editable: EDITABLE.includes(r.type) }),
    })),
    limits: { maxRecords: MAX_RECORDS, types: EDITABLE },
    ...extra,
  };
}

/** Our records (locked, `present` = found in the zone), any stale ones on our names (locked, replaced on the next save), then the merchant's. */
function classify(row, ours, zone, sending) {
  const res = reservation(ours);
  const inZone = new Set(zone.map(keyOf));
  const ourKeys = new Set(ours.map(keyOf));
  const sendingPurpose = new Map(sending.map((s) => [keyOf(s), s.purpose ? `email_${s.purpose}` : 'email']));
  const locked = ours.map((o) => ({ ...o, locked: true, present: inZone.has(keyOf(o)) }));
  const stale = zone.filter((z) => res.isReserved(z) && !ourKeys.has(keyOf(z))).map((z) => ({ ...z, locked: true, purpose: 'routing', present: true }));
  const merchant = zone.filter((z) => !res.isReserved(z)).map((z) => ({ ...z, locked: false, purpose: sendingPurpose.get(keyOf(z)) || null }));
  return { res, locked: [...locked, ...stale], merchant };
}

async function listRecords(workspaceId, id) {
  const row = await findPurchase(workspaceId, id);
  const r = holder(row, ['getRecords'], DNS_UNSUPPORTED);
  const [ours, zone, sending] = await Promise.all([zimosRecords(row), readZone(r, row), sendingRecords(workspaceId, row.hostname)]);
  const { locked, merchant } = classify(row, ours, zone, sending);
  return present(row, [...locked, ...merchant]);
}

/** A record's name as sent ("@", "mail", "mail.mystore.com") → the full name inside `domain`, or null. */
function fullName(input, domain) {
  const n = lower(input);
  const name = n === '' || n === '@' ? domain : n === domain || n.endsWith(`.${domain}`) ? n : `${n}.${domain}`;
  if (name.length > 253) return null;
  const labels = name === domain ? [] : name.slice(0, -(domain.length + 1)).split('.');
  return labels.every((l, i) => LABEL.test(l) || (l === '*' && i === 0)) ? name : null;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** The merchant's records, checked; throws 422 with one detail per problem. */
function checkRecords(domain, input, res) {
  const problems = [];
  const out = [];
  input.forEach((rec, i) => {
    const at = (k, message) => problems.push({ field: `records[${i}].${k}`, message });
    const type = String(rec.type).toUpperCase();
    const name = fullName(rec.name, domain);
    if (!name) return at('name', `Use "@" for ${domain} or a name like "mail" (letters, digits, "-", "_")`);
    const value = ['CNAME', 'MX'].includes(type) ? lower(rec.value) : String(rec.value).trim();
    const r = { type, name, value, ttl: rec.ttl || 300 };
    if (type === 'MX') {
      if (rec.priority === undefined || rec.priority === null) return at('priority', 'An MX record needs a priority (0–65535, lower is tried first)');
      r.priority = rec.priority;
    } else if (rec.priority !== undefined && rec.priority !== null) {
      return at('priority', 'Only an MX record has a priority');
    }
    if (type === 'A' && !net.isIPv4(value)) return at('value', 'Enter an IPv4 address like 203.0.113.10');
    if (type === 'AAAA' && !net.isIPv6(value)) return at('value', 'Enter an IPv6 address like 2001:db8::1');
    if ((type === 'CNAME' || type === 'MX') && (net.isIP(value) || !HOSTNAME.test(value))) return at('value', type === 'MX' ? 'Enter the mail server\'s name, like mx.example.com (not an IP address)' : 'Enter a host name like shops.example.com');
    if (type === 'CNAME' && name === domain) return at('name', `${domain} itself can't have a CNAME record — use A records`);
    if (type === 'CNAME' && value === name) return at('value', 'A CNAME record can\'t point to itself');
    if (type === 'TXT' && (!value || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))) return at('value', 'Enter the text (up to 1024 characters, on one line)');
    if (res.blocks(r)) return at('name', `${hostOf(name, domain)} is used by the store's own records: it can't be changed here`);
    out.push({ ...r, i });
  });
  // One CNAME per name and nothing beside it; no record twice.
  const seen = new Map();
  for (const r of out) {
    const k = keyOf(r);
    if (seen.has(k)) problems.push({ field: `records[${r.i}]`, message: 'This record is listed twice' });
    seen.set(k, r);
  }
  const byName = new Map();
  out.forEach((r) => byName.set(r.name, [...(byName.get(r.name) || []), r]));
  for (const [name, list] of byName) {
    const cname = list.find((r) => r.type === 'CNAME');
    if (cname && list.length > 1) problems.push({ field: `records[${cname.i}].name`, message: `${hostOf(name, domain)} has a CNAME record, so it can't have any other record` });
  }
  if (problems.length) throw new ValidationError(problems);
  return out.map(({ i, ...r }) => r);
}

async function replaceRecords(workspaceId, id, records, req) {
  const row = await findPurchase(workspaceId, id);
  const r = holder(row, ['getRecords'], DNS_UNSUPPORTED);
  const [ours, zone] = await Promise.all([zimosRecords(row), readZone(r, row)]);
  const { res, merchant: before } = classify(row, ours, zone, []);
  // The write replaces the zone: a record we could not write back would be lost.
  const foreign = before.filter((z) => !EDITABLE.includes(z.type));
  if (foreign.length) throw new AppError('DNS_RECORDS_UNSUPPORTED', `The zone holds records that can't be edited here (${[...new Set(foreign.map((z) => z.type))].join(', ')}) — contact support`, 409);
  const mine = checkRecords(row.hostname, records, res);
  await r.setRecords({ domain: row.hostname, providerRef: row.providerRef, records: [...ours, ...mine] });
  const brief = (list) => list.map((x) => `${x.type} ${hostOf(x.name, row.hostname)}${x.type === 'MX' ? ` ${x.priority}` : ''} ${x.type === 'TXT' ? x.value.slice(0, 80) : x.value}`);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'domain.dns_records', entityType: 'DomainPurchase', entityId: row.id, before: { records: brief(before) }, after: { records: brief(mine) }, req });
  const sending = await sendingRecords(workspaceId, row.hostname);
  const done = classify(row, ours, [...ours, ...mine], sending);
  return present(row, [...done.locked, ...done.merchant]);
}

/**
 * A sending domain set up after the domain was bought (emailDomains/sendingDomain.add):
 * its records are added to the zone beside the merchant's. An SPF or DMARC record the
 * merchant already has on that name is kept (one per name); an older DKIM on the same
 * name and anything on the return-path CNAME's name are replaced. Never throws.
 */
async function addSendingRecords(workspaceId, sendingDomain, req) {
  try {
    const name = lower(sendingDomain);
    const rows = await db.DomainPurchase.findAll({ where: { workspaceId, status: 'active' } });
    const row = rows.find((p) => name === p.hostname || name.endsWith(`.${p.hostname}`));
    if (!row) return null;
    const r = registrar();
    if (r.name !== row.registrar || typeof r.getRecords !== 'function' || !row.providerRef) return null;
    const [ours, zone, sending] = await Promise.all([zimosRecords(row), readZone(r, row), sendingRecords(workspaceId, row.hostname)]);
    const { res, merchant } = classify(row, ours, zone, []);
    if (merchant.some((z) => !EDITABLE.includes(z.type))) return null;
    let kept = merchant.map(({ locked, purpose, present: _p, ...z }) => z);
    const added = [];
    for (const s of sending.filter((x) => !res.blocks(x))) {
      const { purpose, ...rec } = s;
      if (kept.some((z) => keyOf(z) === keyOf(rec))) continue;
      const sameName = kept.filter((z) => z.name === rec.name);
      if (purpose === 'spf' && sameName.some((z) => z.type === 'TXT' && /^v=spf1/i.test(z.value))) continue;
      if (purpose === 'dmarc' && sameName.some((z) => z.type === 'TXT' && /^v=dmarc1/i.test(z.value))) continue;
      if (rec.type === 'CNAME') kept = kept.filter((z) => z.name !== rec.name);
      if (purpose === 'dkim') kept = kept.filter((z) => !(z.name === rec.name && z.type === 'TXT' && /^v=dkim1/i.test(z.value)));
      if (rec.type !== 'CNAME' && kept.some((z) => z.name === rec.name && z.type === 'CNAME')) continue;
      kept.push(rec);
      added.push(rec);
    }
    if (!added.length || kept.length > MAX_RECORDS) return null;
    await r.setRecords({ domain: row.hostname, providerRef: row.providerRef, records: [...ours, ...kept] });
    await recordAudit({ workspaceId, actorUserId: req && req.user ? req.user.id : null, action: 'domain.dns_records', entityType: 'DomainPurchase', entityId: row.id, after: { source: 'sending_domain', added: added.map((x) => `${x.type} ${hostOf(x.name, row.hostname)}`) }, req });
    return added.length;
  } catch (err) {
    logger.warn('[domains] sending-domain records not added to the bought domain', { workspaceId, message: err.message });
    return null;
  }
}

async function transferCode(workspaceId, id, password, req, view) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'ownerUserId'] });
  if (!workspace || workspace.ownerUserId !== req.user.id) throw new AppError('NOT_STORE_OWNER', 'Only the store owner can move the domain to another registrar', 403);
  const row = await findPurchase(workspaceId, id);
  const r = holder(row, ['unlock', 'authCode'], TRANSFER_UNSUPPORTED);
  // As for handing over the store (storeTransfer): the owner's password, every time.
  const me = await db.User.findByPk(req.user.id, { attributes: ['id', 'passwordHash'] });
  if (!me || !me.passwordHash) throw new ValidationError([{ field: 'password', message: 'Set a password on your account first' }]);
  if (!(await verifyPassword(password, me.passwordHash))) throw new ValidationError([{ field: 'password', message: 'The password is not right' }]);

  await r.unlock({ domain: row.hostname, providerRef: row.providerRef });
  const { authCode } = await r.authCode({ domain: row.hostname, providerRef: row.providerRef });
  const autoRenewWas = row.autoRenew;
  // The domain is leaving: it is not renewed here any more.
  await row.update({ autoRenew: false, transferUnlockedAt: new Date() });
  // The code itself is never written anywhere — not in the audit, not in the logs.
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'domain.transfer_code', entityType: 'DomainPurchase', entityId: row.id, after: { hostname: row.hostname, registrar: row.registrar, unlocked: true, autoRenew: false, autoRenewWas }, req });
  return {
    hostname: row.hostname,
    authCode,
    unlocked: true,
    autoRenew: false,
    note: 'Auto-renew is off: renew the domain at its new registrar. The store stays connected while its DNS records stay as they are.',
    purchase: view(row),
  };
}

// ------------------------------------------------------------------ routes --

const withId = Joi.object({ workspaceId: Joi.string().uuid().required(), purchaseId: Joi.string().uuid().required() });
const RECORD = Joi.object({
  type: Joi.string().trim().uppercase().valid(...EDITABLE).required(),
  name: Joi.string().trim().allow('').max(253).required(),
  value: Joi.string().trim().min(1).max(1024).required(),
  priority: Joi.number().integer().min(0).max(65535).allow(null),
  ttl: Joi.number().integer().min(60).max(86400),
});
// Wrong passwords count too: a few tries an hour per account.
const transferCodeLimiter = createUserLimiter({ prefix: 'domain-transfer-code', windowMs: 60 * 60 * 1000, max: 5, skip: () => env.isTest });

/** On the domains router (domain.manage), from purchases.mount; `view` is the purchase row's answer shape. */
function mount(router, { view }) {
  router.get('/purchases/:purchaseId/dns-records', validate({ params: withId }), asyncHandler(async (req, res) => res.json(await listRecords(req.tenant.workspaceId, req.params.purchaseId))));
  router.put(
    '/purchases/:purchaseId/dns-records',
    validate({ params: withId, body: Joi.object({ records: Joi.array().items(RECORD).max(MAX_RECORDS).required() }) }),
    asyncHandler(async (req, res) => res.json(await replaceRecords(req.tenant.workspaceId, req.params.purchaseId, req.body.records, req)))
  );
  router.post(
    '/purchases/:purchaseId/transfer-code',
    transferCodeLimiter,
    validate({ params: withId, body: Joi.object({ password: Joi.string().min(1).max(200).required() }) }),
    asyncHandler(async (req, res) => {
      const out = await transferCode(req.tenant.workspaceId, req.params.purchaseId, req.body.password, req, view);
      res.set('Cache-Control', 'no-store');
      res.json(out);
    })
  );
}

module.exports = { mount, capabilities, sendingRecordsFor, addSendingRecords, listRecords, replaceRecords, transferCode, _checkRecords: checkRecords, _reservation: reservation };
