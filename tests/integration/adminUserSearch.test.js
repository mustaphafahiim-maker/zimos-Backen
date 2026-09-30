'use strict';

// GET /admin/users?q= — the platform console's one search box: name (Arabic
// folded), username, email, id (whole or 8+ characters), and a store's name /
// slug / id finding its owner and members. Creators and admins only.

const { app, request, registerAndActivate, createWorkspace, makePlatformUser, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');

const search = (H, query) => request(app).get('/api/v1/admin/users').set(H).query(query);

async function world() {
  const admin = await makePlatformUser('admin');
  const ahmed = await registerAndActivate({ fullName: 'أحمد سامي' });
  await db.User.update({ username: 'ahmed.sami' }, { where: { id: ahmed.userId } });
  const store = await createWorkspace(ahmed.accessToken, 'متجر الورد البلدي');
  const member = await addMemberWithRole(ahmed.accessToken, store.id, 'editor', 'Nour Member');
  const other = await registerAndActivate({ fullName: 'Karim Other' });
  await db.User.update({ username: 'karim.o' }, { where: { id: other.userId } });
  return { admin, ahmed, store, member, other };
}

const ids = (res) => res.body.users.map((u) => u.id);

describe('admin user search', () => {
  it('finds people by name (Arabic folded), username, email and id', async () => {
    const w = await world();
    const H = w.admin.H;

    // "احمد" (plain alef) finds "أحمد".
    expect(ids(await search(H, { q: 'احمد' }))).toEqual([w.ahmed.userId]);
    expect(ids(await search(H, { q: 'AHMED.S' }))).toEqual([w.ahmed.userId]);
    expect(ids(await search(H, { q: w.other.email.slice(0, 12) }))).toContain(w.other.userId);
    expect(ids(await search(H, { q: w.other.userId }))).toEqual([w.other.userId]);
    expect(ids(await search(H, { q: w.other.userId.slice(0, 8) }))).toEqual([w.other.userId]);
    // Fewer than 8 characters of an id is not an id search.
    expect(ids(await search(H, { q: w.other.userId.slice(0, 5) }))).not.toContain(w.other.userId);

    const row = (await search(H, { q: 'ahmed.sami' })).body.users[0];
    expect(row).toMatchObject({ id: w.ahmed.userId, username: 'ahmed.sami', fullName: 'أحمد سامي', email: w.ahmed.email });
    expect(row.workspaces).toEqual([
      expect.objectContaining({ id: w.store.id, name: 'متجر الورد البلدي', slug: w.store.slug, role: 'owner' }),
    ]);
    expect(row.workspaces[0].subscription).toMatchObject({ status: expect.any(String), phase: expect.any(String) });
  });

  it('finds the owner and the members of a store by its name, slug or id — each person once', async () => {
    const w = await world();
    const H = w.admin.H;
    const byName = await search(H, { q: 'الورد' });
    expect(ids(byName).sort()).toEqual([w.ahmed.userId, w.member.userId].sort());
    const owner = byName.body.users.find((u) => u.id === w.ahmed.userId);
    expect(owner.workspaces[0].matched).toBe(true);
    const member = byName.body.users.find((u) => u.id === w.member.userId);
    expect(member.workspaces[0]).toMatchObject({ id: w.store.id, role: 'editor' });

    expect(ids(await search(H, { q: w.store.slug })).sort()).toEqual([w.ahmed.userId, w.member.userId].sort());
    expect(ids(await search(H, { q: w.store.id })).sort()).toEqual([w.ahmed.userId, w.member.userId].sort());

    // Matching both the person and their store still lists them once.
    await db.Workspace.update({ name: 'Ahmed Store' }, { where: { id: w.store.id } });
    const both = await search(H, { q: 'ahmed' });
    expect(ids(both).filter((id) => id === w.ahmed.userId)).toHaveLength(1);
  });

  it('pages the results and lists everyone for an empty search', async () => {
    const w = await world();
    const page1 = await search(w.admin.H, { q: '', limit: 2, page: 1 });
    expect(page1.status).toBe(200);
    expect(page1.body.users).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(4);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await search(w.admin.H, { q: '', limit: 2, page: 2 });
    expect(ids(page2).some((id) => ids(page1).includes(id))).toBe(false);
    expect((await search(w.admin.H, { limit: 500 })).status).toBe(422);
  });

  it('treats LIKE wildcards as text', async () => {
    const w = await world();
    expect((await search(w.admin.H, { q: '%' })).body.users).toEqual([]);
    expect((await search(w.admin.H, { q: '_' })).body.total).toBeLessThan(4);
  });

  it('is for creators and admins: an agent or a merchant is refused', async () => {
    const w = await world();
    const agent = await makePlatformUser('agent');
    expect((await search(agent.H, { q: 'ahmed' })).status).toBe(403);
    expect((await request(app).get(`/api/v1/admin/users/${w.ahmed.userId}`).set(agent.H)).status).toBe(403);
    const merchant = { Authorization: `Bearer ${w.ahmed.accessToken}` };
    expect((await search(merchant, { q: 'ahmed' })).status).toBe(403);
  });

  it('shows one user with their stores', async () => {
    const w = await world();
    const res = await request(app).get(`/api/v1/admin/users/${w.member.userId}`).set(w.admin.H);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: w.member.userId, fullName: 'Nour Member' });
    expect(res.body.user.workspaces).toEqual([expect.objectContaining({ id: w.store.id, role: 'editor' })]);
    expect((await request(app).get('/api/v1/admin/users/00000000-0000-4000-8000-000000000000').set(w.admin.H)).status).toBe(404);
  });
});
