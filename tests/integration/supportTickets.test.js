'use strict';

// Support tickets: the merchant side (/workspaces/:id/support/tickets) and the
// platform side (/admin/support/tickets), with the status moves between them.

const { app, request, registerAndActivate, createWorkspace, addMemberWithRole, setPlatformRole } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function merchant(name = 'Support Co') {
  const auth = await registerAndActivate({ fullName: 'Mona Merchant' });
  const workspace = await createWorkspace(auth.accessToken, name);
  return { auth, workspace, H: bearer(auth.accessToken), base: `/api/v1/workspaces/${workspace.id}/support/tickets` };
}

async function admin() {
  const auth = await registerAndActivate({ fullName: 'Adam Admin' });
  await setPlatformRole(auth.userId, 'admin');
  return { auth, H: bearer(auth.accessToken) };
}

function open(m, body = {}) {
  return request(app)
    .post(m.base)
    .set(m.H)
    .send({ subject: 'Payout is late', body: 'Our payout did not arrive this week.', category: 'billing', ...body });
}

const adminReply = (a, id, body) =>
  request(app).post(`/api/v1/admin/support/tickets/${id}/messages`).set(a.H).send(body);

describe('support tickets — merchant side', () => {
  it('opens a ticket with its first message and audits it', async () => {
    const m = await merchant();
    const res = await open(m);

    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      subject: 'Payout is late',
      category: 'billing',
      status: 'open',
      priority: 'normal',
      lastMessageBy: 'merchant',
      createdBy: 'Mona Merchant',
      messageCount: 1,
    });
    expect(res.body.messages).toEqual([
      expect.objectContaining({ authorType: 'merchant', authorName: 'Mona Merchant', body: 'Our payout did not arrive this week.' }),
    ]);

    const audit = await db.AuditLog.findOne({ where: { action: 'support_ticket.create' } });
    expect(audit).toMatchObject({ workspaceId: m.workspace.id, actorUserId: m.auth.userId, entityId: res.body.ticket.id });
    // The body itself is not copied into the audit log.
    expect(JSON.stringify(audit.afterState)).not.toContain('payout did not arrive');
  });

  it("lists the workspace's tickets and shows one with its thread", async () => {
    const m = await merchant();
    const { body } = await open(m);
    await open(m, { subject: 'Second question' });

    const list = await request(app).get(m.base).set(m.H);
    expect(list.status).toBe(200);
    expect(list.body.tickets).toHaveLength(2);

    const one = await request(app).get(`${m.base}/${body.ticket.id}`).set(m.H);
    expect(one.body.ticket.id).toBe(body.ticket.id);
    expect(one.body.messages).toHaveLength(1);
  });

  it('keeps each workspace to its own tickets', async () => {
    const a = await merchant('A Co');
    const b = await merchant('B Co');
    const { body } = await open(a);

    expect((await request(app).get(`${b.base}/${body.ticket.id}`).set(b.H)).status).toBe(404);
    expect((await request(app).post(`${b.base}/${body.ticket.id}/messages`).set(b.H).send({ body: 'hi' })).status).toBe(404);
    expect((await request(app).get(b.base).set(b.H)).body.tickets).toEqual([]);
    // Not a member at all: the tenant boundary answers first.
    expect((await request(app).get(a.base).set(b.H)).status).toBe(404);
  });

  it('needs workspace.manage', async () => {
    const m = await merchant();
    const agent = await addMemberWithRole(m.auth.accessToken, m.workspace.id, 'confirmation_agent');
    const res = await request(app).get(m.base).set(bearer(agent.accessToken));
    expect(res.status).toBe(403);
    expect((await open({ ...m, H: bearer(agent.accessToken) })).status).toBe(403);

    const manager = await addMemberWithRole(m.auth.accessToken, m.workspace.id, 'workspace_manager', 'Manager');
    expect((await open({ ...m, H: bearer(manager.accessToken) })).status).toBe(201);
  });

  it('validates the subject, body and category', async () => {
    const m = await merchant();
    expect((await open(m, { subject: 'x' })).status).toBe(422);
    expect((await open(m, { body: '   ' })).status).toBe(422);
    expect((await open(m, { category: 'gossip' })).status).toBe(422);
    expect((await open(m, { body: 'x'.repeat(5001) })).status).toBe(422);
    expect(await db.SupportTicket.count()).toBe(0);
  });

  it('sees the platform reply signed as Zimos support, and re-opens the ticket by replying', async () => {
    const m = await merchant();
    const a = await admin();
    const { body } = await open(m);
    const id = body.ticket.id;

    await adminReply(a, id, { body: 'We are looking into it.' }).expect(201);
    const seen = await request(app).get(`${m.base}/${id}`).set(m.H);
    expect(seen.body.ticket).toMatchObject({ status: 'pending', lastMessageBy: 'admin' });
    const reply = seen.body.messages[1];
    expect(reply).toMatchObject({ authorType: 'admin', authorName: 'Zimos support', body: 'We are looking into it.' });
    expect(JSON.stringify(seen.body)).not.toContain(a.auth.email);
    expect(JSON.stringify(seen.body)).not.toContain('Adam Admin');

    const answered = await request(app).post(`${m.base}/${id}/messages`).set(m.H).send({ body: 'Thanks!' });
    expect(answered.status).toBe(201);
    expect(answered.body.ticket).toMatchObject({ status: 'open', lastMessageBy: 'merchant' });
    expect(await db.AuditLog.count({ where: { action: 'support_ticket.reply' } })).toBe(1);
  });

  it('refuses a reply on a closed ticket', async () => {
    const m = await merchant();
    const a = await admin();
    const { body } = await open(m);
    await request(app).patch(`/api/v1/admin/support/tickets/${body.ticket.id}`).set(a.H).send({ status: 'closed' }).expect(200);

    const res = await request(app).post(`${m.base}/${body.ticket.id}/messages`).set(m.H).send({ body: 'Hello?' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TICKET_CLOSED');
    expect(await db.SupportTicketMessage.count()).toBe(1);
  });
});

describe('support tickets — platform side', () => {
  it('refuses a non-admin', async () => {
    const m = await merchant();
    const { body } = await open(m);
    expect((await request(app).get('/api/v1/admin/support/tickets').set(m.H)).status).toBe(403);
    expect((await adminReply(m, body.ticket.id, { body: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/support/tickets/${body.ticket.id}`).set(m.H).send({ status: 'closed' })).status).toBe(403);
  });

  it('lists the queue across workspaces with per-status counts and filters', async () => {
    const a = await admin();
    const one = await merchant('One Co');
    const two = await merchant('Two Co');
    const t1 = (await open(one, { subject: 'Shipping labels blank' })).body.ticket;
    const t2 = (await open(two, { subject: 'Refund question' })).body.ticket;
    await adminReply(a, t2.id, { body: 'Answered.' }).expect(201);

    const all = await request(app).get('/api/v1/admin/support/tickets').set(a.H);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.counts).toEqual({ open: 1, pending: 1, resolved: 0, closed: 0 });
    const row = all.body.tickets.find((t) => t.id === t1.id);
    expect(row).toMatchObject({ workspaceName: 'One Co', createdBy: 'Mona Merchant', messageCount: 1 });

    const open1 = await request(app).get('/api/v1/admin/support/tickets?status=open').set(a.H);
    expect(open1.body.tickets.map((t) => t.id)).toEqual([t1.id]);
    const byWs = await request(app).get(`/api/v1/admin/support/tickets?workspaceId=${two.workspace.id}`).set(a.H);
    expect(byWs.body.tickets.map((t) => t.id)).toEqual([t2.id]);
    const byQ = await request(app).get('/api/v1/admin/support/tickets?q=labels').set(a.H);
    expect(byQ.body.tickets.map((t) => t.id)).toEqual([t1.id]);
  });

  it('shows the thread with who answered, replies with a chosen status, and audits against the workspace', async () => {
    const a = await admin();
    const m = await merchant();
    const { body } = await open(m);
    const id = body.ticket.id;

    const res = await adminReply(a, id, { body: 'Fixed on our side.', status: 'resolved' });
    expect(res.status).toBe(201);
    expect(res.body.ticket.status).toBe('resolved');
    expect(res.body.message).toMatchObject({ authorType: 'admin', authorName: 'Adam Admin', authorEmail: a.auth.email });

    const detail = await request(app).get(`/api/v1/admin/support/tickets/${id}`).set(a.H);
    expect(detail.body.messages.map((msg) => msg.authorType)).toEqual(['merchant', 'admin']);

    const audit = await db.AuditLog.findOne({ where: { action: 'support_ticket.admin_reply' } });
    expect(audit).toMatchObject({
      workspaceId: m.workspace.id,
      actorUserId: a.auth.userId,
      entityType: 'SupportTicket',
      entityId: id,
      beforeState: { status: 'open' },
    });
    expect(audit.afterState.status).toBe('resolved');

    const log = await request(app).get(`/api/v1/admin/audit-log?entityType=SupportTicket&workspaceId=${m.workspace.id}`).set(a.H);
    expect(log.body.auditLog.map((e) => e.entityLabel)).toEqual(['Payout is late', 'Payout is late']);
  });

  it('changes status and priority, audits only real changes, and can re-open a closed ticket', async () => {
    const a = await admin();
    const m = await merchant();
    const { body } = await open(m);
    const url = `/api/v1/admin/support/tickets/${body.ticket.id}`;

    const res = await request(app).patch(url).set(a.H).send({ priority: 'urgent', status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatchObject({ priority: 'urgent', status: 'closed', workspaceName: 'Support Co' });
    await request(app).patch(url).set(a.H).send({ priority: 'urgent' }).expect(200);
    expect(await db.AuditLog.count({ where: { action: 'support_ticket.update' } })).toBe(1);

    expect((await adminReply(a, body.ticket.id, { body: 'late' })).status).toBe(409);
    await request(app).patch(url).set(a.H).send({ status: 'open' }).expect(200);
    expect((await adminReply(a, body.ticket.id, { body: 'Back on it.' })).status).toBe(201);
  });

  it('validates the admin writes', async () => {
    const a = await admin();
    const m = await merchant();
    const { body } = await open(m);
    const url = `/api/v1/admin/support/tickets/${body.ticket.id}`;
    expect((await request(app).patch(url).set(a.H).send({})).status).toBe(422);
    expect((await request(app).patch(url).set(a.H).send({ status: 'snoozed' })).status).toBe(422);
    // Replying cannot close a ticket in the same step.
    expect((await adminReply(a, body.ticket.id, { body: 'bye', status: 'closed' })).status).toBe(422);
    expect((await request(app).get('/api/v1/admin/support/tickets/00000000-0000-4000-8000-000000000000').set(a.H)).status).toBe(404);
  });
});
