'use strict';

// Platform admins: GET/POST /admin/admins and DELETE /admin/admins/:userId —
// the users.platform_admin flag on existing accounts, audited on every change.

const { app, request, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');

async function makeAdmin(overrides = {}) {
  const auth = await registerAndActivate(overrides);
  await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
  return { ...auth, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

async function makeUser(overrides = {}) {
  const auth = await registerAndActivate(overrides);
  return { ...auth, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

const grant = (admin, email) => request(app).post('/api/v1/admin/admins').set(admin.H).send({ email });
const revoke = (admin, userId) => request(app).delete(`/api/v1/admin/admins/${userId}`).set(admin.H);
const audits = (action) => db.AuditLog.findAll({ where: { action } });

describe('platform admins', () => {
  it('refuses a non-admin on every route', async () => {
    const plain = await makeUser();
    const other = await makeUser();
    expect((await request(app).get('/api/v1/admin/admins').set(plain.H)).status).toBe(403);
    expect((await grant(plain, plain.email)).status).toBe(403);
    expect((await revoke(plain, other.userId)).status).toBe(403);
    expect((await db.User.findByPk(plain.userId)).platformAdmin).toBe(false);
  });

  it('lists the admins, marking the viewer', async () => {
    const me = await makeAdmin({ fullName: 'First Admin' });
    const other = await makeAdmin({ fullName: 'Second Admin' });
    await makeUser();

    const res = await request(app).get('/api/v1/admin/admins').set(me.H);
    expect(res.status).toBe(200);
    expect(res.body.admins.map((a) => a.id)).toEqual([me.userId, other.userId]);
    expect(res.body.admins[0]).toMatchObject({ email: me.email, fullName: 'First Admin', status: 'active', isYou: true });
    expect(res.body.admins[1].isYou).toBe(false);
    expect(res.body.admins[0]).not.toHaveProperty('passwordHash');
  });

  it('grants the flag by email, whatever its case, and audits it', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();

    const res = await grant(admin, user.email.toUpperCase());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ granted: true, admin: { id: user.userId, email: user.email } });
    expect((await db.User.findByPk(user.userId)).platformAdmin).toBe(true);

    const [row] = await audits('platform_admin.grant');
    expect(row).toMatchObject({
      workspaceId: null,
      actorUserId: admin.userId,
      entityType: 'User',
      entityId: user.userId,
      beforeState: { platformAdmin: false },
      afterState: { platformAdmin: true },
      metadata: { email: user.email },
    });

    // Effective on the very next request — no new token needed.
    expect((await request(app).get('/api/v1/admin/plans').set(user.H)).status).toBe(200);
  });

  it('treats granting an existing admin as a no-op: 200, nothing audited', async () => {
    const admin = await makeAdmin();
    const other = await makeAdmin();
    const res = await grant(admin, other.email);
    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(false);
    expect(await audits('platform_admin.grant')).toHaveLength(0);
  });

  it('refuses an unknown email and an account that is not active', async () => {
    const admin = await makeAdmin();
    const unknown = await grant(admin, 'nobody@example.com');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('USER_NOT_FOUND');

    const pendingEmail = `pending${Date.now()}@example.com`;
    await request(app).post('/api/v1/auth/register').send({ email: pendingEmail, password: 'Passw0rd!123', fullName: 'Pending' });
    const pending = await grant(admin, pendingEmail);
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('USER_NOT_ACTIVE');

    const suspended = await makeUser();
    await db.User.update({ status: 'suspended' }, { where: { id: suspended.userId } });
    expect((await grant(admin, suspended.email)).status).toBe(409);

    expect((await grant(admin, 'not-an-email')).status).toBe(422);
    expect(await db.User.count({ where: { platformAdmin: true } })).toBe(1);
    expect(await audits('platform_admin.grant')).toHaveLength(0);
  });

  it('revokes another admin, effective immediately, and audits it', async () => {
    const admin = await makeAdmin();
    const other = await makeAdmin();

    const res = await revoke(admin, other.userId);
    expect(res.status).toBe(200);
    expect((await db.User.findByPk(other.userId)).platformAdmin).toBe(false);
    expect((await request(app).get('/api/v1/admin/plans').set(other.H)).status).toBe(403);

    const [row] = await audits('platform_admin.revoke');
    expect(row).toMatchObject({
      workspaceId: null,
      actorUserId: admin.userId,
      entityId: other.userId,
      beforeState: { platformAdmin: true },
      afterState: { platformAdmin: false },
    });
  });

  it('refuses to revoke yourself', async () => {
    const admin = await makeAdmin();
    await makeAdmin();
    const res = await revoke(admin, admin.userId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_REVOKE_SELF');
    expect((await db.User.findByPk(admin.userId)).platformAdmin).toBe(true);
    expect(await audits('platform_admin.revoke')).toHaveLength(0);
  });

  it('404s a user who is not an admin', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    expect((await revoke(admin, user.userId)).status).toBe(404);
    expect((await revoke(admin, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await revoke(admin, 'not-a-uuid')).status).toBe(422);
  });

  it('never revokes the last admin, even when two admins revoke each other at once', async () => {
    const a = await makeAdmin();
    const b = await makeAdmin();

    const results = await Promise.all([revoke(a, b.userId), revoke(b, a.userId)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('LAST_ADMIN');

    expect(await db.User.count({ where: { platformAdmin: true } })).toBe(1);
    expect(await audits('platform_admin.revoke')).toHaveLength(1);
  });
});
