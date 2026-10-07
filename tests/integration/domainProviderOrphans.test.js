'use strict';

// No custom hostname left at Cloudflare once its domain row is gone: migration
// 214's trigger queues one on every delete, and the daily reconciliation
// (domainJobs.reconcileProviderHostnames) finds the ones no row knows.
// Cloudflare's fetch is mocked.
jest.mock('../../src/modules/domains/dnsVerifier', () => ({ lookupTxt: jest.fn(), lookupCname: jest.fn() }));
const { lookupTxt } = require('../../src/modules/domains/dnsVerifier');

const Sequelize = require('sequelize');
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const jobs = require('../../src/modules/domains/domainJobs');
const migration = require('../../src/db/migrations/214-add-domain-provider-deletion-trigger');

const REF = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const HOUR = 60 * 60 * 1000;
const reply = (status, body) => ({ status, json: async () => body });
const qi = () => db.sequelize.getQueryInterface();

let fetchMock;
beforeEach(() => {
  lookupTxt.mockReset();
  env.customDomains.enabled = true;
  process.env.CERTIFICATE_PROVIDER = 'cloudflare';
  env.customDomains.cloudflare.apiToken = 'test-only-cloudflare-token';
  env.customDomains.cloudflare.zoneId = '0123456789abcdef0123456789abcdef';
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  fetchMock.mockRestore();
  env.customDomains.enabled = false;
  env.customDomains.reconcileMax = 20;
  delete process.env.CERTIFICATE_PROVIDER;
  env.customDomains.cloudflare.apiToken = '';
  env.customDomains.cloudflare.zoneId = '';
});

async function store(name = 'Orphan Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  await request(app).post(`/api/v1/workspaces/${workspace.id}/quickstart`).set(H).type('form').send({ productName: 'Widget', price: '10.00' });
  const website = await db.Website.findOne({ where: { workspaceId: workspace.id } });
  return { workspaceId: workspace.id, websiteId: website.id, H };
}

const domain = (s, hostname, fields = {}) =>
  db.Domain.create({
    workspaceId: s.workspaceId,
    websiteId: s.websiteId,
    hostname,
    verificationToken: 'tok',
    status: 'verified',
    verifiedAt: new Date(),
    ...fields,
  });

const atProvider = (fields) => ({ sslStatus: 'pending', sslProvider: 'cloudflare', sslProviderRef: REF, ...fields });

describe('every delete of a domain at the provider queues it once (migration 214)', () => {
  it('deleting the store takes its domain by CASCADE and queues exactly one deletion', async () => {
    // No products: a quickstart's offer_variants key refuses a raw workspace delete.
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Cascade Store');
    const website = await db.Website.create({ workspaceId: workspace.id, name: 'Cascade', subdomain: 'cascade-orphans' });
    const s = { workspaceId: workspace.id, websiteId: website.id };
    await domain(s, 'www.cascade.com', atProvider());
    await db.sequelize.query('DELETE FROM workspaces WHERE id = $1', { bind: [s.workspaceId] });

    expect(await db.Domain.count()).toBe(0);
    const rows = await db.DomainProviderDeletion.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostname: 'www.cascade.com', provider: 'cloudflare', providerRef: REF, workspaceId: s.workspaceId });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleting through the API: a Cloudflare failure leaves exactly one row; success leaves none', async () => {
    const s = await store();
    const d = await domain(s, 'www.apidel.com', atProvider());
    fetchMock.mockResolvedValueOnce(reply(500, null));
    expect((await request(app).delete(`/api/v1/workspaces/${s.workspaceId}/domains/${d.id}`).set(s.H)).status).toBe(200);
    const rows = await db.DomainProviderDeletion.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerRef: REF, attempts: 1 });

    await db.DomainProviderDeletion.destroy({ where: {} });
    const ref2 = 'bbbbbbbbccccddddeeeeffffffffffff';
    const e = await domain(s, 'www.apiok.com', atProvider({ sslProviderRef: ref2 }));
    fetchMock.mockResolvedValueOnce(reply(200, { success: true, result: { id: ref2 } }));
    expect((await request(app).delete(`/api/v1/workspaces/${s.workspaceId}/domains/${e.id}`).set(s.H)).status).toBe(200);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining(`/custom_hostnames/${ref2}`), expect.objectContaining({ method: 'DELETE' }));
    expect(await db.DomainProviderDeletion.count()).toBe(0);
  });

  it('a domain never sent to the provider queues nothing, by any path', async () => {
    const s = await store();
    const d = await domain(s, 'www.local.com');
    await domain(s, 'www.local2.com', { status: 'pending_verification', verifiedAt: null });
    expect((await request(app).delete(`/api/v1/workspaces/${s.workspaceId}/domains/${d.id}`).set(s.H)).status).toBe(200);
    await db.sequelize.query('DELETE FROM domains');
    expect(await db.DomainProviderDeletion.count()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the retry job drops, without calling Cloudflare, a queued hostname a domain row holds again', async () => {
    const s = await store();
    await domain(s, 'www.again.com', atProvider({ status: 'active', sslStatus: 'issued' }));
    await db.DomainProviderDeletion.create({ hostname: 'www.again.com', provider: 'cloudflare', providerRef: REF });
    expect(await jobs.retryProviderDeletions()).toEqual({ checked: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.DomainProviderDeletion.count()).toBe(0);
  });
});

describe('migration 214', () => {
  const triggers = async () => {
    const [rows] = await db.sequelize.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'domains'::regclass AND tgname = 'domains_queue_provider_deletion_trg'"
    );
    return rows.length;
  };

  it('up twice, down twice, up again: one trigger, and none after down', async () => {
    const s = await store();
    try {
      await migration.up(qi(), Sequelize);
      expect(await triggers()).toBe(1);
      await migration.down(qi(), Sequelize);
      await migration.down(qi(), Sequelize);
      expect(await triggers()).toBe(0);
      await domain(s, 'www.down.com', atProvider());
      await db.sequelize.query('DELETE FROM domains');
      expect(await db.DomainProviderDeletion.count()).toBe(0);
    } finally {
      await migration.up(qi(), Sequelize);
      await migration.up(qi(), Sequelize);
    }
    expect(await triggers()).toBe(1);
    await domain(s, 'www.up.com', atProvider());
    await db.sequelize.query('DELETE FROM domains');
    expect(await db.DomainProviderDeletion.count()).toBe(1);
  });
});

describe('reconciliation (domains.reconcile_provider_hostnames)', () => {
  const old = new Date(Date.now() - 2 * 24 * HOUR).toISOString();
  const ref = (n) => String(n).padStart(32, 'c');
  const hostnames = (list, page = 1, totalPages = 1) =>
    reply(200, { success: true, result: list, result_info: { page, total_pages: totalPages } });

  it('queues hostnames no row knows, across pages; never one a row knows by ref or name, nor a new one', async () => {
    const s = await store();
    await domain(s, 'www.byref.com', atProvider({ sslProviderRef: ref(1) }));
    await domain(s, 'www.byname.com', { status: 'failed' });
    fetchMock
      .mockResolvedValueOnce(
        hostnames(
          [
            { id: ref(1), hostname: 'www.byref.com', created_at: old },
            { id: ref(2), hostname: 'www.byname.com', created_at: old },
            { id: ref(3), hostname: 'www.orphan-a.com', created_at: old },
          ],
          1,
          2
        )
      )
      .mockResolvedValueOnce(
        hostnames(
          [
            { id: ref(4), hostname: 'www.orphan-b.com', created_at: old },
            { id: ref(5), hostname: 'www.brand-new.com', created_at: new Date().toISOString() },
            { id: ref(6), hostname: 'www.no-date.com' },
          ],
          2,
          2
        )
      );

    expect(await jobs.reconcileProviderHostnames()).toEqual({ listed: 6, orphans: 2, queued: 2, capped: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    const queued = await db.DomainProviderDeletion.findAll({ order: [['hostname', 'ASC']] });
    expect(queued.map((r) => [r.hostname, r.providerRef, r.provider])).toEqual([
      ['www.orphan-a.com', ref(3), 'cloudflare'],
      ['www.orphan-b.com', ref(4), 'cloudflare'],
    ]);

    // Run again: already queued, nothing new.
    fetchMock.mockResolvedValueOnce(hostnames([{ id: ref(3), hostname: 'www.orphan-a.com', created_at: old }]));
    expect(await jobs.reconcileProviderHostnames()).toMatchObject({ orphans: 0, queued: 0 });
    expect(await db.DomainProviderDeletion.count()).toBe(2);
  });

  it('more orphans than CUSTOM_DOMAINS_RECONCILE_MAX: none queued', async () => {
    env.customDomains.reconcileMax = 2;
    const list = [7, 8, 9].map((n) => ({ id: ref(n), hostname: `www.many${n}.com`, created_at: old }));
    fetchMock.mockResolvedValueOnce(hostnames(list));
    expect(await jobs.reconcileProviderHostnames()).toEqual({ listed: 3, orphans: 3, queued: 0, capped: true });
    expect(await db.DomainProviderDeletion.count()).toBe(0);

    fetchMock.mockResolvedValueOnce(hostnames(list.slice(0, 2)));
    expect(await jobs.reconcileProviderHostnames()).toMatchObject({ queued: 2, capped: false });
  });

  it('a page that fails queues nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(hostnames([{ id: ref(3), hostname: 'www.orphan.com', created_at: old }], 1, 2))
      .mockResolvedValueOnce(reply(502, null));
    await expect(jobs.reconcileProviderHostnames()).rejects.toThrow(/502/);
    expect(await db.DomainProviderDeletion.count()).toBe(0);
  });

  it('does nothing while CUSTOM_DOMAINS_ENABLED is off or the provider is not cloudflare', async () => {
    const idle = { listed: 0, orphans: 0, queued: 0, capped: false };
    env.customDomains.enabled = false;
    expect(await jobs.reconcileProviderHostnames()).toEqual(idle);
    env.customDomains.enabled = true;
    delete process.env.CERTIFICATE_PROVIDER;
    expect(await jobs.reconcileProviderHostnames()).toEqual(idle);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
