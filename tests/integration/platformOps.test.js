'use strict';

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  setupWorkspaceWithProduct,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');

// The global beforeEach truncates every table; re-seed plans so workspace
// creation has something to put a trial on.
beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

/** A platform admin plus a workspace they can target. */
async function setupAdmin() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Ops Co');
  await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
  return {
    wid: workspace.id,
    userId: auth.userId,
    H: { Authorization: `Bearer ${auth.accessToken}` },
  };
}

/** A normal (non-admin) user, for the authorization checks. */
async function setupPlain() {
  const auth = await registerAndActivate();
  await createWorkspace(auth.accessToken, 'Plain Co');
  return { H: { Authorization: `Bearer ${auth.accessToken}` } };
}

describe('platform ops — access control', () => {
  it.each([
    '/api/v1/admin/overview',
    '/api/v1/admin/users',
    '/api/v1/admin/audit-logs',
    '/api/v1/admin/templates',
    '/api/v1/admin/system',
  ])('GET %s refuses a non-admin', async (path) => {
    const { H } = await setupPlain();
    expect((await request(app).get(path).set(H)).status).toBe(403);
  });

  it.each([
    '/api/v1/admin/overview',
    '/api/v1/admin/users',
    '/api/v1/admin/audit-logs',
    '/api/v1/admin/templates',
    '/api/v1/admin/system',
  ])('GET %s refuses an anonymous caller', async (path) => {
    expect((await request(app).get(path)).status).toBe(401);
  });
});

describe('platform ops — overview', () => {
  it('counts what is really in the database and returns an unbroken day series', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/overview').set(H);

    expect(res.status).toBe(200);
    const o = res.body.overview;
    expect(o.workspaces.total).toBeGreaterThanOrEqual(1);
    expect(o.workspaces.byStatus.active).toBeGreaterThanOrEqual(1);
    expect(o.workspaces.new30d).toBeGreaterThanOrEqual(1);
    expect(o.subscriptions.byStatus.trialing).toBeGreaterThanOrEqual(1);
    expect(o.users.total).toBeGreaterThanOrEqual(1);
    // No orders exist in this run, so the totals must be zero rather than
    // sample numbers — every figure comes from a query.
    expect(o.orders.total).toBe(0);
    expect(o.orders.last30d).toBe(0);
    expect(o.orders.gmv30dByCurrency).toEqual({});
    // 30 days of buckets, each one a date with an order count.
    expect(o.series.length).toBeGreaterThan(29);
    expect(o.series.every((d) => typeof d.date === 'string' && d.orders === 0)).toBe(true);
  });
});

describe('platform ops — workspaces', () => {
  it('returns the detail of one workspace with its owner, counts and subscription', async () => {
    const { H } = await setupAdmin();
    const { workspace } = await setupWorkspaceWithProduct();

    const res = await request(app).get(`/api/v1/admin/workspaces/${workspace.id}`).set(H);
    expect(res.status).toBe(200);
    const w = res.body.workspace;
    expect(w.id).toBe(workspace.id);
    expect(w.owner.email).toBeTruthy();
    expect(w.counts.products).toBe(1);
    expect(w.counts.orders).toBe(0);
    expect(w.counts.members).toBe(1);
    expect(w.revenue30d).toBe(0);
    expect(w.lastOrderAt).toBeNull();
    expect(w.subscription.status).toBe('trialing');
    // Prices come off pg as strings; the serializer has to cast them.
    expect(typeof w.subscription.plan.monthlyPriceAmount).toBe('number');
  });

  it('404s on an unknown workspace and 422s on a malformed id', async () => {
    const { H } = await setupAdmin();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await request(app).get(`/api/v1/admin/workspaces/${missing}`).set(H)).status).toBe(404);
    expect((await request(app).get('/api/v1/admin/workspaces/not-a-uuid').set(H)).status).toBe(422);
  });

  it('suspends a workspace, takes its storefront offline and records the audit entry', async () => {
    const { H, userId } = await setupAdmin();
    const { workspace } = await setupWorkspaceWithProduct();

    const res = await request(app)
      .patch(`/api/v1/admin/workspaces/${workspace.id}/status`)
      .set(H)
      .send({ status: 'suspended', reason: 'non-payment' });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('suspended');
    expect((await request(app).get(`/api/v1/store/${workspace.id}`)).status).toBe(404);

    const audit = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ workspaceId: workspace.id })
      .set(H);
    const entry = audit.body.logs.find((l) => l.action === 'admin.workspace.status');
    expect(entry).toBeDefined();
    expect(entry.actor.id).toBe(userId);
    expect(entry.before).toEqual({ status: 'active' });
    expect(entry.after).toEqual({ status: 'suspended', reason: 'non-payment' });
  });

  it('rejects a status outside the allowed set', async () => {
    const { H, wid } = await setupAdmin();
    const res = await request(app).patch(`/api/v1/admin/workspaces/${wid}/status`).set(H).send({ status: 'deleted' });
    expect(res.status).toBe(422);
  });

  it('moves a workspace onto another plan and logs the change', async () => {
    const { H, wid } = await setupAdmin();
    const plan = await db.Plan.findOne({ where: { key: 'starter' } });

    const res = await request(app)
      .patch(`/api/v1/admin/workspaces/${wid}/subscription`)
      .set(H)
      .send({ status: 'active', planId: plan.id, billingCycle: 'yearly' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe('active');
    expect(res.body.subscription.billingCycle).toBe('yearly');
    expect(res.body.subscription.plan.key).toBe('starter');

    const audit = await request(app).get('/api/v1/admin/audit-logs').query({ action: 'admin.subscription' }).set(H);
    expect(audit.body.logs.some((l) => l.action === 'admin.subscription.update')).toBe(true);
  });

  it('404s when the target plan does not exist and 422s on an empty body', async () => {
    const { H, wid } = await setupAdmin();
    const missing = '00000000-0000-4000-8000-000000000000';
    const badPlan = await request(app)
      .patch(`/api/v1/admin/workspaces/${wid}/subscription`)
      .set(H)
      .send({ planId: missing });
    expect(badPlan.status).toBe(404);

    const empty = await request(app).patch(`/api/v1/admin/workspaces/${wid}/subscription`).set(H).send({});
    expect(empty.status).toBe(422);
  });
});

describe('platform ops — users', () => {
  it('searches users and counts the workspaces each one belongs to', async () => {
    const { H } = await setupAdmin();
    const other = await registerAndActivate();
    await createWorkspace(other.accessToken, 'Other Co');

    const res = await request(app).get('/api/v1/admin/users').query({ search: other.email }).set(H);
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.id)).toEqual([other.userId]);
    expect(res.body.users[0].workspaces).toBe(1);
    // Fewer rows than the page size means there is nothing after this page.
    expect(res.body.nextCursor).toBeNull();
  });

  it('paginates with a cursor', async () => {
    const { H } = await setupAdmin();
    await registerAndActivate();

    const first = await request(app).get('/api/v1/admin/users').query({ limit: 1 }).set(H);
    expect(first.body.users).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app)
      .get('/api/v1/admin/users')
      .query({ limit: 1, before: first.body.nextCursor })
      .set(H);
    expect(second.body.users).toHaveLength(1);
    expect(second.body.users[0].id).not.toBe(first.body.users[0].id);
  });

  it('promotes another user and records the change', async () => {
    const { H } = await setupAdmin();
    const other = await registerAndActivate();

    const res = await request(app).patch(`/api/v1/admin/users/${other.userId}`).set(H).send({ platformAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body.user.platformAdmin).toBe(true);
    expect((await db.User.findByPk(other.userId)).platformAdmin).toBe(true);

    const audit = await request(app).get('/api/v1/admin/audit-logs').query({ entityType: 'User' }).set(H);
    expect(audit.body.logs.some((l) => l.action === 'admin.user.update')).toBe(true);
  });

  it('never lets an admin remove their own access or suspend themselves', async () => {
    const { H, userId } = await setupAdmin();

    const demote = await request(app).patch(`/api/v1/admin/users/${userId}`).set(H).send({ platformAdmin: false });
    expect(demote.status).toBe(422);
    expect(demote.body.error.code).toBe('CANNOT_DEMOTE_SELF');

    const suspend = await request(app).patch(`/api/v1/admin/users/${userId}`).set(H).send({ status: 'suspended' });
    expect(suspend.status).toBe(422);

    expect((await db.User.findByPk(userId)).platformAdmin).toBe(true);
  });

  it('rejects a status that is not in the users enum', async () => {
    const { H } = await setupAdmin();
    const other = await registerAndActivate();
    const res = await request(app).patch(`/api/v1/admin/users/${other.userId}`).set(H).send({ status: 'zombie' });
    expect(res.status).toBe(422);
  });
});

describe('platform ops — audit log', () => {
  it('filters by action prefix across every workspace', async () => {
    const { H, wid } = await setupAdmin();
    await request(app).patch(`/api/v1/admin/workspaces/${wid}/status`).set(H).send({ status: 'suspended' });

    const all = await request(app).get('/api/v1/admin/audit-logs').set(H);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.logs)).toBe(true);

    const filtered = await request(app).get('/api/v1/admin/audit-logs').query({ action: 'admin.workspace' }).set(H);
    expect(filtered.body.logs.length).toBeGreaterThan(0);
    expect(filtered.body.logs.every((l) => l.action.startsWith('admin.workspace'))).toBe(true);
    expect(filtered.body.logs[0].workspace).toEqual({ id: wid, name: 'Ops Co' });
  });
});

describe('platform ops — templates', () => {
  it('lists templates with their versions, page counts and site usage', async () => {
    const { H } = await setupAdmin();
    const template = await db.Template.create({ name: 'Boutique', category: 'fashion', isPublished: false });
    await db.TemplateVersion.create({
      templateId: template.id,
      version: 1,
      pages: [{ path: '/' }, { path: '/about' }],
    });

    const res = await request(app).get('/api/v1/admin/templates').set(H);
    expect(res.status).toBe(200);
    const row = res.body.templates.find((t) => t.id === template.id);
    expect(row.name).toBe('Boutique');
    expect(row.versions).toHaveLength(1);
    expect(row.versions[0].pageCount).toBe(2);
    expect(row.versions[0].websites).toBe(0);
  });

  it('publishes a template and records the change', async () => {
    const { H } = await setupAdmin();
    const template = await db.Template.create({ name: 'Boutique', isPublished: false });

    const res = await request(app)
      .patch(`/api/v1/admin/templates/${template.id}`)
      .set(H)
      .send({ name: 'Boutique Pro', isPublished: true });
    expect(res.status).toBe(200);
    expect(res.body.template).toEqual({
      id: template.id,
      name: 'Boutique Pro',
      category: null,
      thumbnailUrl: null,
      isPublished: true,
    });

    const audit = await request(app).get('/api/v1/admin/audit-logs').query({ entityType: 'Template' }).set(H);
    expect(audit.body.logs.some((l) => l.action === 'admin.template.update')).toBe(true);
  });

  it('404s on an unknown template', async () => {
    const { H } = await setupAdmin();
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await request(app).patch(`/api/v1/admin/templates/${missing}`).set(H).send({ isPublished: true });
    expect(res.status).toBe(404);
  });
});

describe('platform ops — system health', () => {
  it('reports the live state of this server', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/system').set(H);

    expect(res.status).toBe(200);
    const s = res.body.system;
    expect(s.database).toBe('connected');
    // Counted off disk and out of SequelizeMeta, not hard-coded.
    expect(s.migrations.files).toBeGreaterThan(0);
    expect(Array.isArray(s.migrations.pending)).toBe(true);
    expect(s.environment).toBe('test');
    expect(s.node).toBe(process.version);
    expect(typeof s.uptimeSeconds).toBe('number');
    expect(s.storage).toBeTruthy();
  });
});
