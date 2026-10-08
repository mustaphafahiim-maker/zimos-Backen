'use strict';

const env = require('../../../config/env');
const { CertificateProviderError } = require('./errors');

/**
 * Cloudflare for SaaS custom hostnames: Cloudflare issues and renews a DV
 * certificate for a merchant's hostname once its CNAME points at our zone.
 * The contract is in README.md.
 *
 * The address is fixed (api.cloudflare.com), so nothing a merchant types
 * changes where a request goes. The token comes from CLOUDFLARE_API_TOKEN
 * only and is never put in a message, a log line or an error.
 */

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10000;
// Cloudflare's id for a custom hostname: 32 hex characters (a uuid allowed too).
const REF = /^[0-9a-f-]{8,64}$/i;
const DUPLICATE_CODES = new Set([1406]);

function config() {
  const { apiToken, zoneId } = env.customDomains.cloudflare;
  if (!apiToken || !zoneId) {
    throw new CertificateProviderError('Cloudflare is not configured (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID)', {
      retryable: false,
    });
  }
  if (!/^[0-9a-f]{32}$/i.test(zoneId)) {
    throw new CertificateProviderError('CLOUDFLARE_ZONE_ID is not a Cloudflare zone id', { retryable: false });
  }
  return { apiToken, zoneId };
}

/** Cloudflare's own error messages, without anything we sent. */
function errorText(body) {
  const errors = (body && Array.isArray(body.errors) && body.errors) || [];
  return errors
    .map((e) => `${e.code || ''} ${e.message || ''}`.trim())
    .filter(Boolean)
    .join('; ')
    .slice(0, 300);
}

/**
 * One call. Answers { status, body }; throws CertificateProviderError when
 * Cloudflare cannot be reached, times out, refuses the token, or fails on its
 * side. A 404 and a 4xx with Cloudflare errors come back to the caller.
 */
async function call(method, path, body) {
  const { apiToken, zoneId } = config();
  let res;
  try {
    res = await fetch(`${API}/zones/${zoneId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new CertificateProviderError(timedOut ? 'Cloudflare did not answer in time' : 'Cloudflare could not be reached', {
      retryable: true,
    });
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    throw new CertificateProviderError('Cloudflare refused the API token', { retryable: false });
  }
  if (res.status === 429 || res.status >= 500) {
    throw new CertificateProviderError(`Cloudflare is unavailable (${res.status})`, { retryable: true });
  }
  return { status: res.status, body: json };
}

const firstMessage = (list) => {
  const item = (Array.isArray(list) && list[0]) || null;
  if (!item) return null;
  return String(typeof item === 'string' ? item : item.message || '').slice(0, 300) || null;
};

/**
 * Cloudflare's state of a custom hostname, in the contract's words:
 * issued (hostname and certificate active), moved (the merchant's CNAME no
 * longer points at us), failed (blocked, timed out, expired, removed) with
 * Cloudflare's reason as detail, else pending.
 */
function mapStatus(result) {
  const status = String((result && result.status) || '');
  const ssl = (result && result.ssl) || {};
  const sslStatus = String(ssl.status || '');
  const detail = firstMessage(ssl.validation_errors) || firstMessage(result && result.verification_errors);
  if (status === 'moved') return { status: 'moved', detail: detail || 'The domain no longer points at the store' };
  if (status === 'active' && sslStatus === 'active') return { status: 'issued', detail: null };
  if (
    ['blocked', 'test_blocked', 'test_failed', 'deleted'].includes(status) ||
    sslStatus.endsWith('_timed_out') ||
    ['expired', 'deleted', 'inactive'].includes(sslStatus)
  ) {
    return { status: 'failed', detail: detail || `Cloudflare: ${status || sslStatus}` };
  }
  return { status: 'pending', detail };
}

function present(result) {
  return { ...mapStatus(result), providerRef: result.id };
}

function refused(body, fallback) {
  return new CertificateProviderError(errorText(body) || fallback, { retryable: false });
}

async function findByHostname(hostname) {
  const { status, body } = await call('GET', `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  const result = status === 200 && body && Array.isArray(body.result) ? body.result.find((r) => r.hostname === hostname) : null;
  if (!result) throw refused(body, 'Cloudflare reported a duplicate hostname it could not find');
  return result;
}

const cloudflare = {
  code: 'cloudflare',

  async requestCertificate({ hostname }) {
    const { status, body } = await call('POST', '/custom_hostnames', {
      hostname,
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
    });
    if ((status === 200 || status === 201) && body && body.success && body.result) return present(body.result);
    const duplicate = body && Array.isArray(body.errors) && body.errors.some((e) => DUPLICATE_CODES.has(Number(e.code)));
    if (duplicate) return present(await findByHostname(hostname));
    throw refused(body, `Cloudflare refused the hostname (${status})`);
  },

  async getStatus({ providerRef }) {
    if (!REF.test(String(providerRef || ''))) {
      throw new CertificateProviderError('Not a Cloudflare custom hostname id', { retryable: false });
    }
    const { status, body } = await call('GET', `/custom_hostnames/${providerRef}`);
    if (status === 404) return { status: 'failed', detail: 'Cloudflare has no record of this hostname' };
    if (status === 200 && body && body.result) return mapStatus(body.result);
    throw refused(body, `Cloudflare answered ${status}`);
  },

  // 404 means already gone: that is the outcome asked for.
  async revoke({ providerRef }) {
    if (!REF.test(String(providerRef || ''))) {
      throw new CertificateProviderError('Not a Cloudflare custom hostname id', { retryable: false });
    }
    const { status, body } = await call('DELETE', `/custom_hostnames/${providerRef}`);
    if (status === 404 || (status >= 200 && status < 300)) return { revoked: true };
    throw new CertificateProviderError(errorText(body) || `Cloudflare answered ${status}`, { retryable: true });
  },
};

module.exports = { cloudflare, mapStatus, API };
