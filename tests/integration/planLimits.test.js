'use strict';

// Plan limits (billing/entitlementsService): stores per owner and funnels per
// store per Cairo month, checked only when something is created, under a
// lock, and never taking anything away.

const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { monthWindow } = require('../../src/core/utils/zonedMonth');

const ORIGINAL_SIGNUP = { ...env.signup };
afterEach(() => {
  Object.assign(env.signup, ORIGINAL_SIGNUP);
});

let seq = 0;
function plan(overrides = {}) {
  seq += 1;
  return db.Plan.create({
    key: `limits-${seq}`,
    name: `Limits ${seq}`,
    monthlyPriceAmount: 10000,
    yearlyPriceAmount: 100000,
    currency: 'EGP',
    trialDays: 14,
    features: [],
    isActive: true,
    isPublic: false,
    ...overrides,
  });
}

const H = (auth) => ({ Authorization: `Bearer ${auth.accessToken}` });
const newStore = (auth, name = 'Another store', body = {}) =>
  request(app).post('/api/v1/workspaces').set(H(auth)).send({ name, ...body });
const newFunnel = (auth, wid, name = 'A funnel') => request(app).post(`/api/v1/workspaces/${wid}/funnels`).set(H(auth)).send({ name });
const setPlan = (wid, p) => db.Subscription.update({ planId: p.id }, { where: { workspaceId: wid } });

describe('stores per owner', () => {
  it('never refuses the first store', async () => {
    await plan({ maxStores: 1 }); // the cheapest active plan: every new store's default
    const owner = await registerAndActivate();
    expect((await newStore(owner, 'First')).status).toBe(201);
  });

  it('refuses a store past the limit with PLAN_LIMIT_REACHED', async () => {
    const limited = await plan({ name: 'Solo', maxStores: 2 });
    const owner = await registerAndActivate();
    expect((await newStore(owner, 'One')).status).toBe(201);
    expect((await newStore(owner, 'Two')).status).toBe(201);
    const res = await newStore(owner, 'Three');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.error.details).toEqual({ limit: 'stores', max: 2, used: 2, planName: limited.name });
    expect(await db.Workspace.count({ where: { ownerUserId: owner.userId } })).toBe(2);
  });

  it('treats a null limit as unlimited — every existing plan', async () => {
    await plan({ maxStores: null });
    const owner = await registerAndActivate();
    for (const name of ['Store A', 'Store B', 'Store C', 'Store D']) expect((await newStore(owner, name)).status).toBe(201);
  });

  it('takes the largest limit among the owner’s current plans', async () => {
    await plan({ maxStores: 1, monthlyPriceAmount: 100 }); // default for new stores
    const big = await plan({ maxStores: 3, monthlyPriceAmount: 900000 });
    const owner = await registerAndActivate();
    const first = await createWorkspace(owner.accessToken, 'First');
    // Without the bigger plan, the second store is refused (max 1).
    expect((await newStore(owner, 'Second')).status).toBe(403);
    await setPlan(first.id, big);
    expect((await newStore(owner, 'Second')).status).toBe(201);
    expect((await newStore(owner, 'Third')).status).toBe(201);
    expect((await newStore(owner, 'Fourth')).status).toBe(403);
  });

  it('ignores the plan of a store whose subscription has ended', async () => {
    await plan({ maxStores: 1, monthlyPriceAmount: 100 });
    const big = await plan({ maxStores: null, monthlyPriceAmount: 900000 });
    const owner = await registerAndActivate();
    const first = await createWorkspace(owner.accessToken, 'First');
    await db.Subscription.update(
      { planId: big.id, status: 'active', currentPeriodEnd: new Date(Date.now() - 60 * 1000) },
      { where: { workspaceId: first.id } }
    );
    expect((await newStore(owner, 'Second')).status).toBe(403);
  });

  it('counts draft stores, and not closed ones', async () => {
    env.signup.requireSubscription = true;
    env.signup.draftStoresPerUser = 5;
    await plan({ maxStores: 2 });
    const owner = await registerAndActivate();
    const draft = await createWorkspace(owner.accessToken, 'Draft one');
    expect((await db.Subscription.findOne({ where: { workspaceId: draft.id } })).status).toBe('draft');
    expect((await newStore(owner, 'Draft two')).status).toBe(201);
    expect((await newStore(owner, 'Draft three')).status).toBe(403);
    await db.Workspace.update({ status: 'closed' }, { where: { id: draft.id } });
    expect((await newStore(owner, 'Draft three')).status).toBe(201);
  });

  it('lets only one of two simultaneous stores through the last place', async () => {
    await plan({ maxStores: 2 });
    const owner = await registerAndActivate();
    await createWorkspace(owner.accessToken, 'First');
    const results = await Promise.all([newStore(owner, 'Race A'), newStore(owner, 'Race B'), newStore(owner, 'Race C')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    expect(await db.Workspace.count({ where: { ownerUserId: owner.userId } })).toBe(2);
  });

  it('counts each owner separately', async () => {
    await plan({ maxStores: 1 });
    const a = await registerAndActivate();
    const b = await registerAndActivate();
    await createWorkspace(a.accessToken, 'Store A1');
    expect((await newStore(b, 'Store B1')).status).toBe(201);
    expect((await newStore(a, 'Store A2')).status).toBe(403);
  });

  it('deletes nothing when the limit drops below what the owner has', async () => {
    const p = await plan({ maxStores: null });
    const owner = await registerAndActivate();
    for (const name of ['Store A', 'Store B', 'Store C']) await createWorkspace(owner.accessToken, name);
    await p.update({ maxStores: 1 });
    expect((await newStore(owner, 'Store D')).status).toBe(403);
    expect(await db.Workspace.count({ where: { ownerUserId: owner.userId, status: 'active' } })).toBe(3);
    const ws = await db.Workspace.findOne({ where: { ownerUserId: owner.userId } });
    expect((await request(app).get(`/api/v1/workspaces/${ws.id}/access`).set(H(owner))).body.access.restricted).toBe(false);
  });
});

describe('funnels per month', () => {
  async function setup(limit) {
    const p = await plan({ maxFunnelsPerMonth: limit });
    const owner = await registerAndActivate();
    const ws = await createWorkspace(owner.accessToken, 'Funnel shop');
    await setPlan(ws.id, p);
    return { owner, wid: ws.id, plan: p };
  }

  it('refuses a funnel past the monthly limit, saying when it resets', async () => {
    const { owner, wid } = await setup(2);
    expect((await newFunnel(owner, wid, 'One')).status).toBe(201);
    expect((await newFunnel(owner, wid, 'Two')).status).toBe(201);
    const res = await newFunnel(owner, wid, 'Three');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.error.details).toMatchObject({ limit: 'funnels_per_month', max: 2, used: 2 });
    expect(new Date(res.body.error.details.resetsAt).toISOString()).toBe(monthWindow(new Date()).resetsAt.toISOString());
  });

  it('counts a deleted funnel', async () => {
    const { owner, wid } = await setup(1);
    const funnel = (await newFunnel(owner, wid)).body.funnel;
    expect((await request(app).delete(`/api/v1/workspaces/${wid}/funnels/${funnel.id}`).set(H(owner))).status).toBe(200);
    expect(await db.Funnel.count({ where: { workspaceId: wid } })).toBe(0);
    expect((await newFunnel(owner, wid, 'Again')).status).toBe(403);
  });

  it('counts a copy, and refuses one past the limit', async () => {
    const { owner, wid } = await setup(2);
    const funnel = (await newFunnel(owner, wid)).body.funnel;
    const copy = await request(app).post(`/api/v1/workspaces/${wid}/funnels/${funnel.id}/duplicate`).set(H(owner)).send({});
    expect(copy.status).toBe(201);
    const again = await request(app).post(`/api/v1/workspaces/${wid}/funnels/${funnel.id}/duplicate`).set(H(owner)).send({});
    expect(again.status).toBe(403);
    expect(again.body.error.details.limit).toBe('funnels_per_month');
    expect(await db.FunnelCreation.count({ where: { workspaceId: wid } })).toBe(2);
  });

  it('starts again at midnight on the 1st in Cairo, not in UTC', async () => {
    const { owner, wid } = await setup(1);
    const { start } = monthWindow(new Date());
    const insert = (at) =>
      db.sequelize.query(
        `INSERT INTO funnel_creations (id, workspace_id, funnel_id, source, created_at)
         VALUES (gen_random_uuid(), $wid, NULL, 'create', $at)`,
        { bind: { wid, at } }
      );
    // One minute before the Cairo month began: last month's — this month is still free.
    await insert(new Date(start.getTime() - 60 * 1000));
    const usage = await request(app).get(`/api/v1/workspaces/${wid}/billing`).set(H(owner));
    expect(usage.body.billing.limits.funnelsThisMonth).toMatchObject({ used: 0, max: 1 });
    // The first instant of the Cairo month already counts.
    await insert(start);
    expect((await newFunnel(owner, wid)).status).toBe(403);
  });

  it('works out the Cairo month boundaries across summer time', () => {
    // Cairo is UTC+3 in October until the clocks go back on its last Thursday.
    expect(monthWindow(new Date('2026-10-01T00:30:00Z'))).toEqual({
      start: new Date('2026-09-30T21:00:00Z'),
      resetsAt: new Date('2026-10-31T22:00:00Z'),
    });
    // 23:59 on 30 Sep in Cairo is still September.
    expect(monthWindow(new Date('2026-09-30T20:59:00Z')).start).toEqual(new Date('2026-08-31T21:00:00Z'));
    expect(monthWindow(new Date('2027-01-15T10:00:00Z'))).toEqual({
      start: new Date('2026-12-31T22:00:00Z'),
      resetsAt: new Date('2027-01-31T22:00:00Z'),
    });
  });

  it('lets only one of two simultaneous funnels through the last place', async () => {
    const { owner, wid } = await setup(1);
    const results = await Promise.all([newFunnel(owner, wid, 'A'), newFunnel(owner, wid, 'B')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
  });

  it('is unlimited on a plan with no limit', async () => {
    const { owner, wid } = await setup(null);
    for (let i = 0; i < 4; i += 1) expect((await newFunnel(owner, wid, `F${i}`)).status).toBe(201);
  });

  it('applies a lower limit to new funnels only — existing ones stay, published ones keep serving', async () => {
    const { owner, wid, plan: p } = await setup(null);
    for (let i = 0; i < 3; i += 1) await newFunnel(owner, wid, `F${i}`);
    await p.update({ maxFunnelsPerMonth: 1 });
    expect((await newFunnel(owner, wid, 'More')).status).toBe(403);
    expect(await db.Funnel.count({ where: { workspaceId: wid } })).toBe(3);
    const list = await request(app).get(`/api/v1/workspaces/${wid}/funnels`).set(H(owner));
    expect(list.body.funnels).toHaveLength(3);
  });

  it('counts per store: another store’s funnels never use this one’s allowance', async () => {
    const a = await setup(1);
    const b = await setup(1);
    expect((await newFunnel(a.owner, a.wid)).status).toBe(201);
    expect((await newFunnel(b.owner, b.wid)).status).toBe(201);
    expect((await newFunnel(a.owner, a.wid)).status).toBe(403);
  });
});

describe('limits in the billing summary and the console', () => {
  it('shows the store and funnel usage against the plan', async () => {
    const p = await plan({ maxStores: 3, maxFunnelsPerMonth: 5 });
    const owner = await registerAndActivate();
    const ws = await createWorkspace(owner.accessToken, 'Usage');
    await setPlan(ws.id, p);
    await newFunnel(owner, ws.id);
    const { billing } = (await request(app).get(`/api/v1/workspaces/${ws.id}/billing`).set(H(owner))).body;
    expect(billing.limits.stores).toEqual({ used: 1, max: 3 });
    expect(billing.limits.funnelsThisMonth).toMatchObject({ used: 1, max: 5 });
    expect(billing.trialEndsAt).toBeTruthy();
    expect(billing.subscription.plan).toMatchObject({ maxStores: 3, maxFunnelsPerMonth: 5, trialDays: 14 });
    expect(billing.draft).toBe(false);

    const admin = await makePlatformUser('admin');
    const view = await request(app).get(`/api/v1/admin/workspaces/${ws.id}/subscription`).set(admin.H);
    expect(view.status).toBe(200);
    expect(view.body.limits.stores).toEqual({ used: 1, max: 3 });
    expect(view.body.subscription.draft).toBe(false);
  });

  it('picks up a plan an admin activates by hand, for the next creation', async () => {
    await plan({ maxStores: 1, monthlyPriceAmount: 100 });
    const roomy = await plan({ maxStores: 5, monthlyPriceAmount: 50000 });
    const owner = await registerAndActivate();
    const ws = await createWorkspace(owner.accessToken, 'Upgraded');
    expect((await newStore(owner, 'Second')).status).toBe(403);
    const admin = await makePlatformUser('admin');
    const act = await request(app)
      .post(`/api/v1/admin/workspaces/${ws.id}/subscription/activate`)
      .set(admin.H)
      .send({ planId: roomy.id, duration: { months: 1 }, note: 'Paid by transfer' });
    expect(act.status).toBe(201);
    expect((await newStore(owner, 'Second')).status).toBe(201);
  });
});
