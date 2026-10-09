'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');

/**
 * Nobody hands out more access than they hold (workspaceService.assertCanGrant):
 * a Workspace Manager (users.manage + roles.manage) can neither make themselves
 * Owner, nor demote or remove an Owner, nor give a permission they lack.
 */
async function setup() {
  const owner = await registerAndActivate({ fullName: 'Owner' });
  const workspace = await createWorkspace(owner.accessToken, 'Role Grant Workspace');
  const base = `/api/v1/workspaces/${workspace.id}`;
  const auth = (u) => ({ Authorization: `Bearer ${u.accessToken}` });

  const roles = (await request(app).get(`${base}/roles`).set(auth(owner))).body.roles;
  const role = (key) => roles.find((r) => r.key === key);

  const admin = await registerAndActivate({ fullName: 'Admin' });
  await request(app).post(`${base}/members`).set(auth(owner)).send({ email: admin.email, roleId: role('workspace_manager').id }).expect(201);

  const members = (await request(app).get(`${base}/members`).set(auth(owner))).body.members;
  const membershipOf = (u) => members.find((m) => m.user && m.user.email === u.email);
  return { owner, admin, base, auth, role, membershipOf };
}

describe('team role grants', () => {
  it('refuses a Workspace Manager making themselves Owner', async () => {
    const { admin, base, auth, role, membershipOf } = await setup();
    const res = await request(app)
      .patch(`${base}/members/${membershipOf(admin).id}`)
      .set(auth(admin))
      .send({ roleId: role('owner').id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_ABOVE_YOURS');
  });

  it('refuses a Workspace Manager removing an Owner, even when a second Owner exists', async () => {
    const { owner, admin, base, auth, role, membershipOf } = await setup();
    const owner2 = await registerAndActivate({ fullName: 'Second Owner' });
    await request(app).post(`${base}/members`).set(auth(owner)).send({ email: owner2.email, roleId: role('owner').id }).expect(201);

    const res = await request(app).delete(`${base}/members/${membershipOf(owner).id}`).set(auth(admin));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_ABOVE_YOURS');
  });

  it('refuses inviting with the Owner role or creating a role above the caller', async () => {
    const { admin, base, auth, role } = await setup();
    const someone = await registerAndActivate({ fullName: 'Someone' });

    const invite = await request(app).post(`${base}/members`).set(auth(admin)).send({ email: someone.email, roleId: role('owner').id });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('ROLE_ABOVE_YOURS');

    const created = await request(app)
      .post(`${base}/roles`)
      .set(auth(admin))
      .send({ name: 'Billing', key: 'billing_only', permissions: ['billing.manage'] });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('ROLE_ABOVE_YOURS');
  });

  it('still lets a Workspace Manager work within their own access, and the Owner promote them', async () => {
    const { owner, admin, base, auth, role, membershipOf } = await setup();

    const created = await request(app)
      .post(`${base}/roles`)
      .set(auth(admin))
      .send({ name: 'Products', key: 'products_only', permissions: ['products.view', 'products.manage'] });
    expect(created.status).toBe(201);

    const someone = await registerAndActivate({ fullName: 'Someone' });
    await request(app).post(`${base}/members`).set(auth(admin)).send({ email: someone.email, roleId: created.body.role.id }).expect(201);

    const promoted = await request(app)
      .patch(`${base}/members/${membershipOf(admin).id}`)
      .set(auth(owner))
      .send({ roleId: role('owner').id });
    expect(promoted.status).toBe(200);
  });
});
