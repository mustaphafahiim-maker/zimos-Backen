'use strict';

// Notes and follow-ups on customers (modules/customerNotes, STORE_FEATURES customer_notes).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { notifyDue } = require('../../src/modules/customerNotes');

afterEach(() => {
  env.storeFeatures.length = 0;
});

async function setup() {
  const { auth, workspace } = await setupWorkspaceWithProduct();
  const customer = await db.Customer.create({ workspaceId: workspace.id, fullName: 'Mona Ali', phoneNormalized: '+201001234567' });
  return { auth, workspace, customer, H: { Authorization: `Bearer ${auth.accessToken}` }, base: `/api/v1/workspaces/${workspace.id}/customer-notes` };
}

describe('customer notes and follow-ups', () => {
  it('are off until STORE_FEATURES names them', async () => {
    const { H, base, customer, workspace, auth } = await setup();
    const res = await request(app).get(`${base}/customers/${customer.id}`).set(H);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');

    // A follow-up already due tells nobody while the feature is off.
    await db.CustomerFollowup.create({ workspaceId: workspace.id, customerId: customer.id, assigneeUserId: auth.user.id, createdBy: auth.user.id, title: 'Call back', dueAt: new Date(Date.now() - 60000) });
    await notifyDue();
    expect(await db.MerchantNotification.count({ where: { workspaceId: workspace.id, type: 'customer.followup' } })).toBe(0);
  });

  it('keeps notes with their author, pinned first, and reminds the assignee once', async () => {
    env.storeFeatures.push('customer_notes');
    const { H, base, customer, workspace, auth } = await setup();

    const first = await request(app).post(`${base}/customers/${customer.id}/notes`).set(H).send({ body: 'Prefers evening calls' });
    expect(first.status).toBe(201);
    const pinned = await request(app).post(`${base}/customers/${customer.id}/notes`).set(H).send({ body: 'Wholesale buyer', isPinned: true });
    expect(pinned.status).toBe(201);
    expect((await request(app).post(`${base}/customers/${customer.id}/notes`).set(H).send({ body: '' })).status).toBe(422);

    const edited = await request(app).patch(`${base}/notes/${first.body.id}`).set(H).send({ body: 'Prefers calls after 6' });
    expect(edited.body.body).toBe('Prefers calls after 6');

    const due = await request(app).post(`${base}/customers/${customer.id}/followups`).set(H).send({ title: 'Call back about the order', dueAt: new Date(Date.now() - 60000).toISOString() });
    expect(due.status).toBe(201);
    expect(due.body).toMatchObject({ overdue: true, assignee: { id: auth.user.id } });

    const page = await request(app).get(`${base}/customers/${customer.id}`).set(H);
    expect(page.body.notes.map((n) => n.body)).toEqual(['Wholesale buyer', 'Prefers calls after 6']);
    expect(page.body.followups).toHaveLength(1);

    const mine = await request(app).get(`${base}/followups`).set(H);
    expect(mine.body).toMatchObject({ overdue: 1 });

    await notifyDue();
    await notifyDue();
    expect(await db.MerchantNotification.count({ where: { workspaceId: workspace.id, type: 'customer.followup' } })).toBe(1);

    const done = await request(app).patch(`${base}/followups/${due.body.id}`).set(H).send({ done: true });
    expect(done.body.doneAt).not.toBeNull();
    expect((await request(app).get(`${base}/followups`).set(H)).body.followups).toHaveLength(0);

    expect((await request(app).delete(`${base}/notes/${pinned.body.id}`).set(H)).status).toBe(204);
  });
});
