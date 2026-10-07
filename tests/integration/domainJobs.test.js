'use strict';

// The custom domains jobs (modules/domains/domainJobs.js), with Cloudflare's fetch mocked.
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const jobs = require('../../src/modules/domains/domainJobs');

const REF = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const HOUR = 60 * 60 * 1000;
const reply = (status, body) => ({ status, json: async () => body });

let fetchMock;
beforeEach(() => {
  env.customDomains.enabled = true;
  process.env.CERTIFICATE_PROVIDER = 'cloudflare';
  env.customDomains.cloudflare.apiToken = 'test-only-cloudflare-token';
  env.customDomains.cloudflare.zoneId = '0123456789abcdef0123456789abcdef';
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  fetchMock.mockRestore();
  env.customDomains.enabled = false;
  env.planFeatures.enforcement = false;
  delete process.env.CERTIFICATE_PROVIDER;
  env.customDomains.cloudflare.apiToken = '';
  env.customDomains.cloudflare.zoneId = '';
});

async function store(name = 'Jobs Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/quickstart`)
    .set({ Authorization: `Bearer ${auth.accessToken}` })
    .type('form')
    .send({ productName: 'Widget', price: '10.00' });
  const website = await db.Website.findOne({ where: { workspaceId: workspace.id } });
  return { workspaceId: workspace.id, websiteId: website.id };
}

const domain = (s, hostname, fields = {}) =>
  db.Domain.create({ ...s, hostname, verificationToken: 'tok', status: 'verified', verifiedAt: new Date(), ...fields });

it('declares the six schedules', () => {
  const names = require('../../src/modules/domains/jobs').schedules.map((s) => [s.name, s.everyMs]);
  expect(names).toEqual([
    ['domains.poll_certificates', 5 * 60 * 1000],
    ['domains.check_active_certificates', 24 * HOUR],
    ['domains.retry_provider_deletions', 15 * 60 * 1000],
    ['domains.remove_expired_pending', HOUR],
    ['domains.enforce_access', 10 * 60 * 1000],
    ['domains.reconcile_provider_hostnames', 24 * HOUR],
  ]);
});

describe('pending certificates', () => {
  it('asks again for a verified domain with no request yet, and asks a pending one where it stands', async () => {
    const s = await store();
    const fresh = await domain(s, 'www.fresh.com');
    const pending = await domain(await store('Other'), 'www.pending.com', { sslStatus: 'pending', sslProvider: 'cloudflare', sslProviderRef: REF });
    fetchMock.mockImplementation(async (url, init) => {
      if (init.method === 'POST') return reply(201, { success: true, result: { id: 'bbbbbbbbccccddddeeeeffffffffffff', status: 'pending', ssl: { status: 'pending_validation' } } });
      return reply(200, { success: true, result: { id: REF, status: 'active', ssl: { status: 'active' } } });
    });

    expect(await jobs.pollPendingCertificates()).toEqual({ checked: 2, failed: 0 });
    expect(await fresh.reload()).toMatchObject({ sslStatus: 'pending', sslProviderRef: 'bbbbbbbbccccddddeeeeffffffffffff' });
    expect(await pending.reload()).toMatchObject({ sslStatus: 'issued', status: 'active' });
  });

  it('fails a certificate still not issued 72 hours after verification, with a reason', async () => {
    const s = await store();
    const old = await domain(s, 'www.slow.com', {
      sslStatus: 'pending',
      sslProviderRef: REF,
      verifiedAt: new Date(Date.now() - 73 * HOUR),
    });
    await jobs.pollPendingCertificates();
    expect(fetchMock).not.toHaveBeenCalled();
    await old.reload();
    expect(old.sslStatus).toBe('failed');
    expect(old.sslDetail).toMatch(/72 hours/);
  });

  it('does nothing while CUSTOM_DOMAINS_ENABLED is off or no provider is set', async () => {
    await domain(await store(), 'www.idle.com');
    env.customDomains.enabled = false;
    expect(await jobs.pollPendingCertificates()).toEqual({ checked: 0, failed: 0 });
    env.customDomains.enabled = true;
    delete process.env.CERTIFICATE_PROVIDER;
    expect(await jobs.pollPendingCertificates()).toEqual({ checked: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it('the daily check notices a domain that moved away', async () => {
  const d = await domain(await store(), 'www.gone.com', { status: 'active', sslStatus: 'issued', sslProviderRef: REF });
  fetchMock.mockResolvedValueOnce(reply(200, { success: true, result: { id: REF, status: 'moved', ssl: { status: 'active' } } }));
  await jobs.checkActiveCertificates();
  expect((await d.reload()).sslStatus).toBe('moved');
});

it('retries a failed provider deletion until it is done, waiting longer each time', async () => {
  const due = await db.DomainProviderDeletion.create({ hostname: 'www.a.com', provider: 'cloudflare', providerRef: REF, attempts: 1 });
  fetchMock.mockResolvedValueOnce(reply(502, null));
  await jobs.retryProviderDeletions();
  await due.reload();
  expect(due.attempts).toBe(2);
  expect(due.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 1000);

  fetchMock.mockResolvedValueOnce(reply(404, { success: false, errors: [] }));
  await jobs.retryProviderDeletions(Date.now() + 2 * HOUR);
  expect(await db.DomainProviderDeletion.count()).toBe(0);
});

it('removes pending rows past their 7 days, and nothing else', async () => {
  const s = await store();
  const t = await store('Two');
  const stale = await domain(s, 'www.stale.com', { status: 'pending_verification', verifiedAt: null });
  const fresh = await domain(t, 'www.stale.com', { status: 'pending_verification', verifiedAt: null });
  const kept = await domain(await store('Three'), 'www.kept.com');
  const eightDays = new Date(Date.now() - 8 * 24 * HOUR);
  await db.sequelize.query('UPDATE domains SET created_at = $1 WHERE id IN ($2, $3)', { bind: [eightDays, stale.id, kept.id] });

  expect(await jobs.removeExpiredPending()).toEqual({ removed: 1 });
  expect(await db.Domain.findByPk(stale.id)).toBeNull();
  expect(await db.Domain.findByPk(fresh.id)).not.toBeNull();
  expect(await db.Domain.findByPk(kept.id)).not.toBeNull();
});

describe('suspended store or plan without custom_domain', () => {
  const resolve = (host) => request(app).get('/api/v1/store/resolve-host').query({ host });

  it('a suspended store: its domain is suspended (not deleted), not served, and back when the store is', async () => {
    const s = await store();
    const d = await domain(s, 'www.paused.com');
    expect((await resolve('www.paused.com')).status).toBe(200);

    await db.Workspace.update({ status: 'suspended', suspendedAt: new Date(), suspensionReason: 'Test' }, { where: { id: s.workspaceId } });
    expect(await jobs.enforceAccess()).toEqual({ suspended: 1, restored: 0 });
    expect(await d.reload()).toMatchObject({ suspendedReason: 'store_suspended', status: 'verified' });
    expect((await resolve('www.paused.com')).status).toBe(404);
    expect((await request(app).get('/').set('Host', 'www.paused.com')).text).not.toContain('Widget');

    await db.Workspace.update({ status: 'active', suspendedAt: null, suspensionReason: null }, { where: { id: s.workspaceId } });
    expect(await jobs.enforceAccess()).toEqual({ suspended: 0, restored: 1 });
    expect((await d.reload()).suspendedAt).toBeNull();
    expect((await resolve('www.paused.com')).status).toBe(200);
  });

  it('with PLAN_FEATURE_ENFORCEMENT on, a plan without custom_domain suspends the domain; off, nothing changes', async () => {
    const s = await store();
    const d = await domain(s, 'www.planless.com');
    expect(await jobs.enforceAccess()).toEqual({ suspended: 0, restored: 0 });
    env.planFeatures.enforcement = true;
    await jobs.enforceAccess();
    expect((await d.reload()).suspendedReason).toBe('plan');
  });

  it('does nothing while CUSTOM_DOMAINS_ENABLED is off', async () => {
    const s = await store();
    await domain(s, 'www.offline.com');
    await db.Workspace.update({ status: 'suspended', suspendedAt: new Date(), suspensionReason: 'Test' }, { where: { id: s.workspaceId } });
    env.customDomains.enabled = false;
    expect(await jobs.enforceAccess()).toEqual({ suspended: 0, restored: 0 });
  });
});
