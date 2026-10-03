'use strict';

// Merchant audit log and invoices — read endpoints added so the dashboard has
// no local/mock data. (The media library, billing overview and confirmation
// queue have their own upstream tests.)

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('merchant audit log and invoices', () => {
  it('lists audit entries with the actor', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/audit-logs`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThan(0);
    expect(res.body.logs.some((l) => l.actor && l.actor.email === auth.email)).toBe(true);
  });

  it('lists invoices (empty until one is issued)', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/invoices`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.invoices)).toBe(true);
  });
});
