'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;

/*
 * Sandbox sending-domain provider. It hands out the DNS records a mail
 * service would ask for and checks them with real DNS lookups, so the whole
 * flow (records shown → merchant adds them → "Verify") works before any mail
 * service account exists. Nothing is registered anywhere.
 *
 * Domains under the reserved test TLDs (.test, .example, .invalid, .localhost)
 * always verify, so the flow can be exercised without owning a domain.
 */

const RESERVED = /\.(test|example|invalid|localhost)$/i;
const SPF_INCLUDE = 'spf.mail.zimos.example';

function records(domain, providerRef) {
  const key = crypto.createHash('sha256').update(`dkim:${providerRef}`).digest('base64').slice(0, 64);
  return [
    { purpose: 'spf', type: 'TXT', name: domain, value: `v=spf1 include:${SPF_INCLUDE} ~all` },
    { purpose: 'dkim', type: 'TXT', name: `zimos._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${key}` },
    { purpose: 'return_path', type: 'CNAME', name: `bounces.${domain}`, value: 'bounces.mail.zimos.example' },
    { purpose: 'dmarc', type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none' },
  ];
}

async function addDomain(domain) {
  const providerRef = `sbx_${crypto.randomBytes(8).toString('hex')}`;
  return { providerRef, records: records(domain, providerRef) };
}

async function lookup(record) {
  try {
    if (record.type === 'CNAME') {
      const names = await dns.resolveCname(record.name);
      return names.some((n) => n.replace(/\.$/, '').toLowerCase() === record.value.toLowerCase());
    }
    const txt = (await dns.resolveTxt(record.name)).map((parts) => parts.join(''));
    // SPF: one SPF record that includes ours (the merchant may have other includes).
    if (record.purpose === 'spf') return txt.some((t) => t.startsWith('v=spf1') && t.includes(`include:${SPF_INCLUDE}`));
    if (record.purpose === 'dmarc') return txt.some((t) => t.startsWith('v=DMARC1'));
    return txt.some((t) => t.replace(/\s+/g, '') === record.value.replace(/\s+/g, ''));
  } catch {
    return false;
  }
}

async function verify({ domain, records: given }) {
  const list = given && given.length ? given : records(domain, 'x');
  const checked = RESERVED.test(domain) ? list.map((r) => ({ ...r, ok: true })) : await Promise.all(list.map(async (r) => ({ ...r, ok: await lookup(r) })));
  // DMARC is advised, not required.
  const verified = checked.filter((r) => r.purpose !== 'dmarc').every((r) => r.ok);
  return { verified, records: checked };
}

async function removeDomain() {}

module.exports = { addDomain, verify, removeDomain };
