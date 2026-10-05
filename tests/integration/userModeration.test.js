'use strict';

// Suspending and soft-deleting an account from the console
// (platformAdmin/userModerationService).
//
//   POST /admin/users/:userId/suspend     workspaces.manage
//   POST /admin/users/:userId/unsuspend   workspaces.manage
//   POST /admin/users/:userId/delete      workspaces.manage

const { app, request, registerAndActivate, makePlatformUser, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const post = (actor, userId, action, body) =>
  request(app).post(`/api/v1/admin/users/${userId}/${action}`).set(actor.H).send(body);
const me = (auth) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${auth.accessToken}`);
const login = (auth) => request(app).post('/api/v1/auth/login').send({ email: auth.email, password: auth.password });
const refresh = (auth) => request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });

describe('console user moderation', () => {
  it('suspends: sign-in refused with ACCOUNT_SUSPENDED, a valid token refused, sessions revoked, audited', async () => {
    const admin = await makePlatformUser('creator');
    const user = await registerAndActivate();
    expect((await me(user)).status).toBe(200);

    const res = await post(admin, user.userId, 'suspend', { reason: 'Fraud reports', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('suspended');

    const signIn = await login(user);
    expect(signIn.status).toBe(401);
    expect(signIn.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await me(user)).status).toBe(401);
    expect((await refresh(user)).status).toBe(401);
    expect(await db.Session.count({ where: { userId: user.userId, revokedAt: null } })).toBe(0);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'user.suspend' } });
    expect(audit.entityId).toBe(user.userId);
    expect(audit.actorUserId).toBe(admin.userId);

    const back = await post(admin, user.userId, 'unsuspend', { confirm: true });
    expect(back.status).toBe(200);
    expect((await login(user)).status).toBe(200);
    expect(await db.AuditLog.count({ where: { action: 'user.unsuspend' } })).toBe(1);
  });

  it('wants the confirmation and a reason', async () => {
    const admin = await makePlatformUser('creator');
    const user = await registerAndActivate();
    expect((await post(admin, user.userId, 'suspend', { reason: 'x y' })).status).toBe(422);
    expect((await post(admin, user.userId, 'suspend', { confirm: true })).status).toBe(422);
    expect((await post(admin, user.userId, 'delete', {})).status).toBe(422);
  });

  it('soft-deletes: anonymised, sign-in and token refused, the row kept, audited', async () => {
    const admin = await makePlatformUser('creator');
    const user = await registerAndActivate();

    const res = await post(admin, user.userId, 'delete', { confirm: true, reason: 'Asked to be removed' });
    expect(res.status).toBe(200);

    const row = await db.User.findByPk(user.userId);
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(row.status).toBe('suspended');
    expect(row.email).not.toBe(user.email);
    expect(row.phone).toBeNull();
    expect(row.fullName).toBe('Deleted user');
    expect(row.passwordHash).toBeNull();

    expect((await login(user)).status).toBe(401);
    expect((await me(user)).status).toBe(401);
    expect((await refresh(user)).status).toBe(401);
    expect(await db.AuditLog.count({ where: { action: 'user.delete', entityId: user.userId } })).toBe(1);
  });

  it('an owner of stores is deleted only with stores: suspend, and those stores are suspended', async () => {
    const admin = await makePlatformUser('creator');
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken);

    const refused = await post(admin, owner.userId, 'delete', { confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('OWNS_STORES');
    expect((await db.User.findByPk(owner.userId)).deletedAt).toBeNull();

    const res = await post(admin, owner.userId, 'delete', { confirm: true, stores: 'suspend' });
    expect(res.status).toBe(200);
    expect(res.body.user.suspendedStores).toEqual([workspace.id]);
    expect((await db.Workspace.findByPk(workspace.id)).status).toBe('suspended');
  });

  it('refuses acting on yourself, and a non-creator acting on the creator', async () => {
    const creator = await makePlatformUser('creator');
    const self = await post(creator, creator.userId, 'suspend', { reason: 'Testing', confirm: true });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('CANNOT_ACT_ON_SELF');

    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['workspaces.view', 'workspaces.manage'] }, { where: { id: admin.userId } });
    const onCreator = await post(admin, creator.userId, 'delete', { confirm: true });
    expect(onCreator.status).toBe(403);
    expect(onCreator.body.error.code).toBe('CREATOR_REQUIRED');
    expect((await db.User.findByPk(creator.userId)).deletedAt).toBeNull();
  });

  it('needs workspaces.manage', async () => {
    const agent = await makePlatformUser('agent');
    const user = await registerAndActivate();
    expect((await post(agent, user.userId, 'suspend', { reason: 'Testing', confirm: true })).status).toBe(403);
  });
});
