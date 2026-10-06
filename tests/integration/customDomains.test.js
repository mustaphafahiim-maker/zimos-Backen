'use strict';

// Control the single DNS lookup. Hoisted above the app require by Jest.
jest.mock('../../src/modules/domains/dnsVerifier', () => ({ lookupTxt: jest.fn(), lookupCname: jest.fn() }));
const { lookupTxt, lookupCname } = require('../../src/modules/domains/dnsVerifier');

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

beforeEach(() => {
  lookupTxt.mockReset();
  lookupCname.mockReset();
  env.customDomains.enabled = true;
});
afterAll(() => {
  env.customDomains.enabled = false;
});

async function setupStore(name = 'Domain Co') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  // A store must exist (a Website) before a domain can be attached.
  await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/quickstart`)
    .set(H)
    .type('form')
    .send({ productName: 'Domain Widget', price: '30.00' });
  return { auth, workspace, wid: workspace.id, H };
}

const addDomain = (wid, H, hostname = 'www.ahmedstore.com') =>
  request(app).post(`/api/v1/workspaces/${wid}/domains`).set(H).send({ hostname });

describe('custom domains', () => {
  it('adding a domain starts as pending_verification with a TXT record to add', async () => {
    const { wid, H } = await setupStore();
    const res = await addDomain(wid, H);
    expect(res.status).toBe(201);
    expect(res.body.domain.hostname).toBe('www.ahmedstore.com');
    expect(res.body.domain.status).toBe('pending_verification');
    expect(res.body.record.type).toBe('TXT');
    expect(res.body.record.name).toBe('_zimos-verify.www.ahmedstore.com');
    expect(res.body.record.value).toMatch(/^zimos-verify=[0-9a-f]{32}$/);

    const row = await db.Domain.findOne({ where: { workspaceId: wid, hostname: 'www.ahmedstore.com' } });
    expect(row.status).toBe('pending_verification');
    expect(row.verificationToken.length).toBe(32);
  });

  it('an unverified claim does not block the real owner; the first to verify takes the host', async () => {
    const a = await setupStore('Store A');
    const squat = await addDomain(a.wid, a.H, 'www.clash.com');
    expect(squat.status).toBe(201);
    const b = await setupStore('Store B');
    const owner = await addDomain(b.wid, b.H, 'www.clash.com');
    expect(owner.status).toBe(201);

    lookupTxt.mockResolvedValueOnce([[owner.body.record.value]]);
    const ok = await request(app).post(`/api/v1/workspaces/${b.wid}/domains/${owner.body.domain.id}/verify`).set(b.H);
    expect(ok.status).toBe(200);
    // Store A's pending row went with it.
    expect(await db.Domain.findByPk(squat.body.domain.id)).toBeNull();

    const c = await setupStore('Store C');
    const late = await addDomain(c.wid, c.H, 'www.clash.com');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('DOMAIN_TAKEN');
  });

  it('the database refuses a second verified row for one hostname', async () => {
    const a = await setupStore('Store A');
    const b = await setupStore('Store B');
    const one = await addDomain(a.wid, a.H, 'www.twice.com');
    const two = await addDomain(b.wid, b.H, 'www.twice.com');
    await db.Domain.update({ status: 'verified' }, { where: { id: one.body.domain.id } });
    await expect(db.Domain.update({ status: 'verified' }, { where: { id: two.body.domain.id } })).rejects.toThrow();
  });

  it('verification succeeds only when the TXT record is actually present', async () => {
    const { wid, H } = await setupStore();
    const add = await addDomain(wid, H);
    const domainId = add.body.domain.id;
    const token = add.body.record.value; // "zimos-verify=<token>"

    // No record yet -> stays pending, 400.
    lookupTxt.mockResolvedValueOnce([['v=spf1 include:_spf.example.com ~all']]);
    const fail = await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H);
    expect(fail.status).toBe(400);
    expect(fail.body.error.code).toBe('DOMAIN_NOT_VERIFIED');
    expect((await db.Domain.findByPk(domainId)).status).toBe('pending_verification');

    // DNS not resolvable at all -> also just "not yet".
    lookupTxt.mockRejectedValueOnce(Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }));
    expect((await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H)).status).toBe(400);

    // Record present -> verified.
    lookupTxt.mockResolvedValueOnce([['unrelated'], [token]]);
    const ok = await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H);
    expect(ok.status).toBe(200);
    expect(ok.body.domain.status).toBe('verified');
    // The TXT is looked up on its own name, never on the host that carries the CNAME.
    expect(lookupTxt).toHaveBeenLastCalledWith('_zimos-verify.www.ahmedstore.com');
    const row = await db.Domain.findByPk(domainId);
    expect(row.status).toBe('verified');
    expect(row.verifiedAt).not.toBeNull();
  });

  it('a verified custom domain Host header resolves to that workspace store', async () => {
    const { wid, H, workspace } = await setupStore('Verified Store');
    const add = await addDomain(wid, H, 'www.myverifiedshop.com');
    const domainId = add.body.domain.id;
    lookupTxt.mockResolvedValueOnce([[add.body.record.value]]);
    await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H);

    const res = await request(app).get('/').set('Host', 'www.myverifiedshop.com');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Verified Store');
    expect(res.text).toContain('Domain Widget');
  });

  it('an unverified custom domain Host header shows a "not verified" message, not the store', async () => {
    const { wid, H } = await setupStore('Pending Store');
    await addDomain(wid, H, 'www.notyet.com');

    const res = await request(app).get('/').set('Host', 'www.notyet.com');
    expect(res.status).toBe(409);
    expect(res.text).toMatch(/not verified/i);
    expect(res.text).not.toContain('Domain Widget');
  });

  it('an unknown Host header (no Domain row) still falls through untouched', async () => {
    const { wid, H } = await setupStore('Fallthrough Co');
    const health = await request(app).get('/health').set('Host', 'never-added.com');
    expect(health.status).toBe(200);
    const shop = await request(app).get(`/shop/${wid}`).set('Host', 'never-added.com');
    expect(shop.status).toBe(200);
  });
});

describe('CUSTOM_DOMAINS_ENABLED off', () => {
  it('answers every merchant domains route with the 404 of an unknown path', async () => {
    const { wid, H } = await setupStore('Closed Domains');
    const fake = '00000000-0000-4000-8000-000000000000';
    env.customDomains.enabled = false;
    const base = `/api/v1/workspaces/${wid}/domains`;
    const attempts = [
      request(app).post(base).set(H).send({ hostname: 'www.closedshop.com' }),
      request(app).get(base).set(H),
      request(app).get(`${base}/overview`).set(H),
      request(app).post(`${base}/${fake}/verify`).set(H),
      request(app).patch(`${base}/${fake}`).set(H).send({ isPrimary: true }),
      request(app).post(`${base}/${fake}/ssl/check`).set(H),
      request(app).get(`${base}/${fake}/dns-check`).set(H),
      request(app).delete(`${base}/${fake}`).set(H),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    }
    // No token: the same answer as any unknown path under the workspace.
    const unknown = await request(app).get(`/api/v1/workspaces/${wid}/no-such-thing`);
    const noToken = await request(app).get(base);
    expect(noToken.status).toBe(unknown.status);
    expect(noToken.body.error.code).toBe(unknown.body.error.code);
    expect(await db.Domain.count({ where: { workspaceId: wid } })).toBe(0);
  });

  it('a domain verified before the switch went off still resolves', async () => {
    const { wid, H, workspace } = await setupStore('Still Resolves');
    const add = await addDomain(wid, H, 'www.stillresolves.com');
    lookupTxt.mockResolvedValueOnce([[add.body.record.value]]);
    expect((await request(app).post(`/api/v1/workspaces/${wid}/domains/${add.body.domain.id}/verify`).set(H)).status).toBe(200);

    env.customDomains.enabled = false;
    const res = await request(app).get('/api/v1/store/resolve-host').query({ host: 'www.stillresolves.com' });
    expect(res.status).toBe(200);
    expect(res.body.store.workspaceId).toBe(wid);
    expect(res.body.store.slug).toBe(workspace.slug);
  });
});

describe('which hostnames a store can connect', () => {
  it('refuses a bare apex with APEX_NOT_SUPPORTED and points at www', async () => {
    const { wid, H } = await setupStore();
    for (const apex of ['example-shop.com', 'https://Example-Shop.com/', 'mystore.com.eg']) {
      const res = await addDomain(wid, H, apex);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('APEX_NOT_SUPPORTED');
      expect(res.body.error.message).toContain('www.');
    }
    expect((await addDomain(wid, H, 'shop.mystore.com.eg')).status).toBe(201);
  });

  it('refuses our own zones, the host provider, private names and IP addresses', async () => {
    const { wid, H } = await setupStore();
    const refused = [
      'www.zimos.co',
      'zimos.co',
      'evil.up.railway.app',
      'api.railway.internal',
      'printer.local',
      'www.localhost',
      'www.shop.test',
      'www.shop.invalid',
      'www.shop.example',
      `www.${env.platformRootDomain}`,
    ];
    for (const host of refused) {
      const res = await addDomain(wid, H, host);
      expect([res.status, res.body.error.code, host]).toEqual([400, 'DOMAIN_NOT_ALLOWED', host]);
    }
    for (const ip of ['10.0.0.1', '169.254.169.254', '[::1]']) {
      const res = await addDomain(wid, H, ip);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await db.Domain.count({ where: { workspaceId: wid } })).toBe(0);
  });

  it('takes an Arabic (IDN) name and stores the form browsers send', async () => {
    const { wid, H } = await setupStore();
    const res = await addDomain(wid, H, 'متجر.مثال.مصر');
    expect(res.status).toBe(201);
    expect(res.body.domain.hostname).toMatch(/^xn--[a-z0-9-]+\.xn--[a-z0-9-]+\.xn--[a-z0-9-]+$/);
  });

  it('one domain per store by default (CUSTOM_DOMAINS_MAX_PER_STORE)', async () => {
    const { wid, H } = await setupStore();
    expect(env.customDomains.maxPerStore).toBe(1);
    expect((await addDomain(wid, H, 'www.first.com')).status).toBe(201);
    const second = await addDomain(wid, H, 'shop.second.com');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DOMAIN_LIMIT_REACHED');
    const again = await addDomain(wid, H, 'www.first.com');
    expect(again.body.error.code).toBe('DOMAIN_ALREADY_ADDED');
  });

  it('a pending row expires after 7 days: it cannot be verified and no longer counts', async () => {
    const { wid, H } = await setupStore();
    const old = await addDomain(wid, H, 'www.stale.com');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.sequelize.query('UPDATE domains SET created_at = $1 WHERE id = $2', { bind: [eightDaysAgo, old.body.domain.id] });

    lookupTxt.mockResolvedValueOnce([[old.body.record.value]]);
    const verify = await request(app).post(`/api/v1/workspaces/${wid}/domains/${old.body.domain.id}/verify`).set(H);
    expect(verify.status).toBe(409);
    expect(verify.body.error.code).toBe('DOMAIN_VERIFICATION_EXPIRED');

    expect((await addDomain(wid, H, 'www.fresh.com')).status).toBe(201);
    expect(await db.Domain.findByPk(old.body.domain.id)).toBeNull();
  });
});

describe('the records and the DNS check', () => {
  it('lists a TXT on _zimos-verify.<host> and a CNAME to the fixed target', async () => {
    const { wid, H } = await setupStore();
    await addDomain(wid, H, 'shop.records.com');
    const res = await request(app).get(`/api/v1/workspaces/${wid}/domains/overview`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.cnameTarget).toBe(env.customDomains.cnameTarget);
    const [txt, cname] = res.body.domains[0].records;
    expect(txt).toMatchObject({ type: 'TXT', name: '_zimos-verify.shop.records.com' });
    expect(cname).toMatchObject({ type: 'CNAME', name: 'shop.records.com', value: env.customDomains.cnameTarget });
  });

  it('checks the two records through the public resolver module', async () => {
    const { wid, H } = await setupStore();
    const add = await addDomain(wid, H, 'shop.check.com');
    lookupTxt.mockResolvedValueOnce([[add.body.record.value]]);
    lookupCname.mockResolvedValueOnce([`${env.customDomains.cnameTarget}.`]);
    const res = await request(app).get(`/api/v1/workspaces/${wid}/domains/${add.body.domain.id}/dns-check`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.dns.txt.found).toBe(true);
    expect(res.body.dns.cname.found).toBe(true);
    expect(lookupTxt).toHaveBeenCalledWith('_zimos-verify.shop.check.com');
    expect(lookupCname).toHaveBeenCalledWith('shop.check.com');
  });
});
