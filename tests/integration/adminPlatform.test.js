'use strict';

// Platform admin control endpoints: overview, workspace detail/status,
// subscriptions, plans, users, platform audit log, templates and system health.

const { app, request, setupWorkspaceWithProduct, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function makeAdmin() {
  const auth = await registerAndActivate();
  await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
  return auth;
}

describe('platform admin API', () => {
  it('is refused for non-admins', async () => {
    const auth = await registerAndActivate();
    const res = await request(app).get('/api/v1/admin/overview').set(bearer(auth.accessToken));
    expect(res.status).toBe(403);
  });

  it('shows the overview and a workspace, and changes its status and subscription', async () => {
    const admin = await makeAdmin();
    const { workspace } = await setupWorkspaceWithProduct();

    const overview = await request(app).get('/api/v1/admin/overview').set(bearer(admin.accessToken));
    expect(overview.status).toBe(200);
    expect(overview.body.overview.workspaces.total).toBeGreaterThanOrEqual(1);
    expect(overview.body.overview.series.length).toBeGreaterThan(0);

    const detail = await request(app).get(`/api/v1/admin/workspaces/${workspace.id}`).set(bearer(admin.accessToken));
    expect(detail.status).toBe(200);
    expect(detail.body.workspace.counts.products).toBe(1);
    expect(detail.body.workspace.subscription.status).toBe('trialing');

    const suspended = await request(app)
      .patch(`/api/v1/admin/workspaces/${workspace.id}/status`)
      .set(bearer(admin.accessToken))
      .send({ status: 'suspended', reason: 'test' });
    expect(suspended.status).toBe(200);
    expect((await request(app).get(`/api/v1/store/${workspace.id}`)).status).toBe(404);

    const sub = await request(app)
      .patch(`/api/v1/admin/workspaces/${workspace.id}/subscription`)
      .set(bearer(admin.accessToken))
      .send({ status: 'active' });
    expect(sub.status).toBe(200);
    expect(sub.body.subscription.status).toBe('active');

    const audit = await request(app).get('/api/v1/admin/audit-logs').query({ workspaceId: workspace.id }).set(bearer(admin.accessToken));
    expect(audit.body.logs.some((l) => l.action === 'admin.workspace.status')).toBe(true);
  });

  it('manages plans and users, and never lets an admin demote themselves', async () => {
    const admin = await makeAdmin();
    const created = await request(app)
      .post('/api/v1/admin/plans')
      .set(bearer(admin.accessToken))
      .send({ key: `pro-${Date.now()}`, name: 'Pro', monthlyPriceAmount: 150000, yearlyPriceAmount: 1500000, currency: 'EGP' });
    expect(created.status).toBe(201);
    const updated = await request(app).patch(`/api/v1/admin/plans/${created.body.plan.id}`).set(bearer(admin.accessToken)).send({ isActive: false });
    expect(updated.body.plan.isActive).toBe(false);
    const plans = await request(app).get('/api/v1/admin/plans').set(bearer(admin.accessToken));
    expect(plans.body.plans.some((p) => p.id === created.body.plan.id)).toBe(true);

    const other = await registerAndActivate();
    const users = await request(app).get('/api/v1/admin/users').query({ search: other.email }).set(bearer(admin.accessToken));
    expect(users.body.users.map((u) => u.id)).toEqual([other.userId]);
    const promoted = await request(app).patch(`/api/v1/admin/users/${other.userId}`).set(bearer(admin.accessToken)).send({ platformAdmin: true });
    expect(promoted.body.user.platformAdmin).toBe(true);

    const self = await request(app).patch(`/api/v1/admin/users/${admin.userId}`).set(bearer(admin.accessToken)).send({ platformAdmin: false });
    expect(self.status).toBe(422);
  });

  it('lists templates and reports system health', async () => {
    const admin = await makeAdmin();
    const templates = await request(app).get('/api/v1/admin/templates').set(bearer(admin.accessToken));
    expect(templates.status).toBe(200);
    expect(Array.isArray(templates.body.templates)).toBe(true);

    const system = await request(app).get('/api/v1/admin/system').set(bearer(admin.accessToken));
    expect(system.status).toBe(200);
    expect(system.body.system.database).toBe('connected');
    expect(system.body.system.migrations.files).toBeGreaterThan(0);
  });
});
