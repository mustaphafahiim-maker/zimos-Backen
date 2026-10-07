'use strict';

// The Cloudflare for SaaS adapter, with fetch mocked: nothing leaves the machine.
const env = require('../../src/config/env');
const { cloudflare, mapStatus, API } = require('../../src/modules/domains/certificates/cloudflare');
const { getCertificateProvider, CertificateProviderError } = require('../../src/modules/domains/certificates');

const TOKEN = 'test-only-cloudflare-token-never-real';
const ZONE = '0123456789abcdef0123456789abcdef';
const REF = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

const reply = (status, body) => ({ status, json: async () => body });
const hostnameResult = (over = {}) => ({
  id: REF,
  hostname: 'www.shop.com',
  status: 'pending',
  ssl: { status: 'pending_validation' },
  ...over,
});

let fetchMock;
beforeEach(() => {
  env.customDomains.cloudflare.apiToken = TOKEN;
  env.customDomains.cloudflare.zoneId = ZONE;
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  fetchMock.mockRestore();
  env.customDomains.cloudflare.apiToken = '';
  env.customDomains.cloudflare.zoneId = '';
  delete process.env.CERTIFICATE_PROVIDER;
});

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

it('is the adapter for CERTIFICATE_PROVIDER=cloudflare', () => {
  process.env.CERTIFICATE_PROVIDER = 'cloudflare';
  expect(getCertificateProvider()).toBe(cloudflare);
});

it('creates the custom hostname: fixed URL, token in the header, http DV with TLS 1.2', async () => {
  fetchMock.mockResolvedValueOnce(reply(201, { success: true, result: hostnameResult() }));
  const out = await cloudflare.requestCertificate({ hostname: 'www.shop.com' });
  expect(out).toEqual({ status: 'pending', detail: null, providerRef: REF });

  const [url, init] = fetchMock.mock.calls[0];
  expect(API).toBe('https://api.cloudflare.com/client/v4');
  expect(url).toBe(`${API}/zones/${ZONE}/custom_hostnames`);
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(init.signal).toBeDefined();
  expect(JSON.parse(init.body)).toEqual({
    hostname: 'www.shop.com',
    ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
  });
});

it('a duplicate hostname is looked up by name and its id reused', async () => {
  fetchMock
    .mockResolvedValueOnce(reply(409, { success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }] }))
    .mockResolvedValueOnce(reply(200, { success: true, result: [hostnameResult({ status: 'active', ssl: { status: 'active' } })] }));
  const out = await cloudflare.requestCertificate({ hostname: 'www.shop.com' });
  expect(out).toEqual({ status: 'issued', detail: null, providerRef: REF });
  expect(fetchMock.mock.calls[1][0]).toBe(`${API}/zones/${ZONE}/custom_hostnames?hostname=www.shop.com`);
  expect(fetchMock.mock.calls[1][1].method).toBe('GET');
});

it("a refusal carries Cloudflare's reason, not retryable", async () => {
  fetchMock.mockResolvedValueOnce(reply(400, { success: false, errors: [{ code: 1411, message: 'Custom hostname is invalid.' }] }));
  const err = await failure(cloudflare.requestCertificate({ hostname: 'www.shop.com' }));
  expect(err).toBeInstanceOf(CertificateProviderError);
  expect(err.retryable).toBe(false);
  expect(err.message).toContain('Custom hostname is invalid.');
});

it('a timeout and a 5xx are retryable failures', async () => {
  fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  const timeout = await failure(cloudflare.requestCertificate({ hostname: 'www.shop.com' }));
  expect(timeout).toBeInstanceOf(CertificateProviderError);
  expect(timeout.retryable).toBe(true);
  expect(timeout.message).toMatch(/in time/);

  fetchMock.mockResolvedValueOnce(reply(503, null));
  const down = await failure(cloudflare.getStatus({ providerRef: REF }));
  expect(down.retryable).toBe(true);
});

it('a bad token is refused without ever showing the token', async () => {
  fetchMock.mockResolvedValueOnce(reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
  const err = await failure(cloudflare.requestCertificate({ hostname: 'www.shop.com' }));
  expect(err.retryable).toBe(false);
  expect(err.message).toBe('Cloudflare refused the API token');
  expect(JSON.stringify({ message: err.message, stack: err.stack })).not.toContain(TOKEN);
});

it('no token or zone: not configured, and nothing is sent', async () => {
  env.customDomains.cloudflare.apiToken = '';
  const err = await failure(cloudflare.requestCertificate({ hostname: 'www.shop.com' }));
  expect(err.retryable).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('delete: 2xx and 404 both count as removed; any other failure is thrown, not swallowed', async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { success: true, result: { id: REF } }));
  await expect(cloudflare.revoke({ providerRef: REF })).resolves.toEqual({ revoked: true });
  expect(fetchMock.mock.calls[0][0]).toBe(`${API}/zones/${ZONE}/custom_hostnames/${REF}`);
  expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');

  fetchMock.mockResolvedValueOnce(reply(404, { success: false, errors: [{ code: 1436, message: 'not found' }] }));
  await expect(cloudflare.revoke({ providerRef: REF })).resolves.toEqual({ revoked: true });

  fetchMock.mockResolvedValueOnce(reply(500, null));
  const err = await failure(cloudflare.revoke({ providerRef: REF }));
  expect(err.retryable).toBe(true);
});

it('refuses a provider ref that is not a Cloudflare id, so nothing else lands in the path', async () => {
  const err = await failure(cloudflare.getStatus({ providerRef: '../../zones' }));
  expect(err).toBeInstanceOf(CertificateProviderError);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('maps Cloudflare states to the contract', () => {
  expect(mapStatus(hostnameResult({ status: 'active', ssl: { status: 'active' } })).status).toBe('issued');
  expect(mapStatus(hostnameResult({ status: 'active', ssl: { status: 'pending_deployment' } })).status).toBe('pending');
  expect(mapStatus(hostnameResult({ status: 'moved' })).status).toBe('moved');
  expect(mapStatus(hostnameResult({ status: 'blocked' })).status).toBe('failed');
  const timedOut = mapStatus(
    hostnameResult({ ssl: { status: 'validation_timed_out', validation_errors: [{ message: 'CAA record prevents issuance' }] } })
  );
  expect(timedOut).toEqual({ status: 'failed', detail: 'CAA record prevents issuance' });
  expect(mapStatus(hostnameResult({ verification_errors: ['custom hostname does not CNAME to this zone.'] })).detail).toBe(
    'custom hostname does not CNAME to this zone.'
  );
});
