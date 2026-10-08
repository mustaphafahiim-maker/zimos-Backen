'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError } = require('../../core/errors/AppError');

/*
 * Brevo sending-domain provider (README.md): the platform's Brevo account
 * (BREVO_API_KEY, the same key notifications/brevoEmailProvider.js sends with)
 * holds every store's domain, over Brevo's senders/domains API:
 *
 *   POST   /v3/senders/domains                          { name }  → id, dns_records
 *   GET    /v3/senders/domains/{domain}                 → verified, authenticated, dns_records (status per record)
 *   PUT    /v3/senders/domains/{domain}/authenticate    → Brevo checks the records now
 *   DELETE /v3/senders/domains/{domain}
 *
 * Brevo's records (brevo-code TXT, DKIM, and SPF / DMARC when it lists them)
 * are shown with full names. One record is ours: a per-store TXT on
 * _zimos-mail.<domain>. Every store shares this one Brevo account, so Brevo's
 * records for a domain are the same for any store that adds it (and a domain
 * the platform itself authenticated reads as authenticated at once); the
 * per-store TXT is what proves this store controls the domain's DNS.
 *
 * A domain that was already in the Brevo account (providerRef `existing:…`)
 * is never deleted from it by a store.
 *
 * BREVO_API_BASE points it at a local stand-in, outside production only.
 */

const TIMEOUT_MS = 15_000;
const RESERVED = /\.(test|example|invalid|localhost)$/i;
const OWNERSHIP_HOST = '_zimos-mail';

const base = () => String((!env.isProduction && process.env.BREVO_API_BASE) || 'https://api.brevo.com').replace(/\/+$/, '');
const apiKey = () => env.notifications.brevo.apiKey;

function isConfigured() {
  return Boolean(apiKey());
}

const unreachable = () => new AppError('EMAIL_DOMAIN_PROVIDER_UNREACHABLE', 'The email service did not answer — try again in a minute', 502);
const unavailable = () => new AppError('EMAIL_DOMAIN_UNAVAILABLE', 'Sending from your own domain is not available yet', 503);

/** One call to Brevo. Answers { status, body } for 2xx, 400 and 404; anything else is thrown as an AppError. */
async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base()}/v3${path}`, {
      method,
      headers: { 'api-key': apiKey(), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn(`[emailDomains] Brevo ${method} ${path.split('/').slice(0, 3).join('/')} failed: ${err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : err.message}`);
    throw unreachable();
  }
  const text = await res.text().catch(() => '');
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (res.ok || res.status === 400 || res.status === 404) return { status: res.status, body: json };
  if (res.status === 401 || res.status === 403) {
    // The platform's key or account (a plan without domains, an IP not allowed): the owner's to fix, not the merchant's.
    logger.error(`[emailDomains] Brevo refused the platform's API key or account (${res.status}${json.code ? ` ${json.code}` : ''}): sending domains are unavailable`);
    throw unavailable();
  }
  logger.warn(`[emailDomains] Brevo answered ${res.status}${json.code ? ` ${json.code}` : ''} to ${method} ${path.split('/').slice(0, 3).join('/')}`);
  throw unreachable();
}

const fqdn = (host, domain) => {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h === '@' || h === domain) return domain;
  return h.endsWith(`.${domain}`) ? h : `${h}.${domain}`;
};

function purposeOf(key) {
  const k = String(key).toLowerCase();
  if (k.includes('brevo_code') || k.includes('brevocode')) return 'brevo_code';
  if (k.includes('dkim')) return 'dkim';
  if (k.includes('spf')) return 'spf';
  if (k.includes('dmarc')) return 'dmarc';
  return k.replace(/_?record$/, '') || 'other';
}

/** Brevo's dns_records ({ key: { type, value, host_name, status } }) as our records, with Brevo's status as `ok`. */
function fromBrevo(domain, dnsRecords) {
  return Object.entries(dnsRecords || {})
    .filter(([, r]) => r && typeof r === 'object' && r.value)
    .map(([key, r]) => ({ purpose: purposeOf(key), type: String(r.type || 'TXT').toUpperCase(), name: fqdn(r.host_name, domain), value: String(r.value), ok: r.status === true }));
}

function ownershipRecord(domain, given) {
  const old = (given || []).find((r) => r.purpose === 'ownership' && /^zimos-mail=[0-9a-f]{32}$/.test(r.value));
  return { purpose: 'ownership', type: 'TXT', name: `${OWNERSHIP_HOST}.${domain}`, value: old ? old.value : `zimos-mail=${crypto.randomBytes(16).toString('hex')}` };
}

/** Brevo's records + ours; DMARC is added as advice when Brevo does not list it (Gmail and Yahoo ask bulk senders for one). */
function recordList(domain, dnsRecords, given) {
  const list = fromBrevo(domain, dnsRecords);
  if (!list.some((r) => r.purpose === 'dmarc')) list.push({ purpose: 'dmarc', type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none' });
  list.push(ownershipRecord(domain, given));
  return list;
}

const strip = (records) => records.map(({ ok, ...r }) => r);

async function txtAt(name) {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

const enc = (domain) => encodeURIComponent(domain);

async function readDomain(domain) {
  const got = await call('GET', `/senders/domains/${enc(domain)}`);
  return got.status === 200 ? got.body : null;
}

async function create(domain, given) {
  const made = await call('POST', '/senders/domains', { name: domain });
  if (made.status >= 200 && made.status < 300) {
    const dnsRecords = made.body.dns_records || ((await readDomain(domain)) || {}).dns_records;
    return { providerRef: `new:${made.body.id != null ? made.body.id : domain}`, records: strip(recordList(domain, dnsRecords, given)) };
  }
  const { code, message } = made.body || {};
  // Already in this Brevo account (another store's pending claim, or added by hand): reuse it, never delete it later.
  if (code === 'duplicate_parameter' || /already (exist|added|present)/i.test(String(message || ''))) {
    const existing = await readDomain(domain);
    if (existing) return { providerRef: `existing:${domain}`, records: strip(recordList(domain, existing.dns_records, given)) };
  }
  throw new AppError('VALIDATION_ERROR', "The email service can't use this domain — check it is a domain you own, like mystore.com", 422, [
    { field: 'domain', message: "The email service can't use this domain — check it is a domain you own, like mystore.com" },
  ]);
}

async function addDomain(domain) {
  return create(domain, []);
}

async function verify({ domain, records: given }) {
  // Ask Brevo to check now; a 400 is "not authenticated yet", which the GET below spells out per record.
  const auth = await call('PUT', `/senders/domains/${enc(domain)}/authenticate`);
  const info = auth.status === 404 ? null : await readDomain(domain);
  if (!info) {
    // Removed from the Brevo account meanwhile: add it again; the records may have changed.
    const again = await create(domain, given);
    return { verified: false, records: again.records.map((r) => ({ ...r, ok: false })), providerRef: again.providerRef };
  }
  const records = recordList(domain, info.dns_records, given);
  const own = records.find((r) => r.purpose === 'ownership');
  const txt = await txtAt(own.name);
  own.ok = txt.some((t) => t.trim() === own.value) || (!env.isProduction && RESERVED.test(domain));
  const dmarc = records.find((r) => r.purpose === 'dmarc' && !r.ok);
  // Advice only (does not block): our own DMARC line has no Brevo status, so it is looked up.
  if (dmarc) dmarc.ok = (await txtAt(dmarc.name)).some((t) => t.startsWith('v=DMARC1'));
  const brevoOk = info.authenticated === true && info.verified !== false;
  return { verified: brevoOk && own.ok, records };
}

async function removeDomain({ domain, providerRef }) {
  if (String(providerRef || '').startsWith('existing:')) return;
  const gone = await call('DELETE', `/senders/domains/${enc(domain)}`);
  if (gone.status === 400) logger.warn(`[emailDomains] Brevo would not delete a sending domain (400${gone.body.code ? ` ${gone.body.code}` : ''})`);
}

module.exports = { isConfigured, addDomain, verify, removeDomain, _fromBrevo: fromBrevo };
