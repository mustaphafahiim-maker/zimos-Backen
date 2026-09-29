'use strict';

// Assigning confirmation tasks to agents, and the channel each attempt used:
// who may assign, who may then claim, the queue's assignment filters, and a
// user from another workspace never becoming an assignee.

const {
  app,
  request,
  setupWorkspaceWithProduct,
  addMemberWithRole,
  registerAndActivate,
  createWorkspace,
} = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function placeOrder(token, workspaceId, variantId, phone = '01000004444') {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `ca-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Assign Buyer', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '4 Assign St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

/** Owner, a manager (order operator), two agents and an editor, with two COD orders. */
async function setup() {
  const ctx = await setupWorkspaceWithProduct({ stock: 20 });
  const ownerToken = ctx.auth.accessToken;
  const ws = ctx.workspace.id;
  const operator = await addMemberWithRole(ownerToken, ws, 'order_operator', 'Operator Omar');
  const agentA = await addMemberWithRole(ownerToken, ws, 'confirmation_agent', 'Agent Amal');
  const agentB = await addMemberWithRole(ownerToken, ws, 'confirmation_agent', 'Agent Bassem');
  const editor = await addMemberWithRole(ownerToken, ws, 'editor', 'Editor Eman');
  const orders = [
    await placeOrder(ownerToken, ws, ctx.variant.id, '01000004441'),
    await placeOrder(ownerToken, ws, ctx.variant.id, '01000004442'),
  ];
  const tasks = await Promise.all(orders.map((o) => db.ConfirmationTask.findOne({ where: { orderId: o.id } })));
  const base = `/api/v1/workspaces/${ws}/confirmation-tasks`;
  return { ...ctx, ownerToken, operator, agentA, agentB, editor, orders, tasks, base };
}

const assign = (ctx, token, taskId, userId) =>
  request(app).post(`${ctx.base}/${taskId}/assign`).set(bearer(token)).send({ userId });
const unassign = (ctx, token, taskId) => request(app).post(`${ctx.base}/${taskId}/unassign`).set(bearer(token)).send({});
const claim = (ctx, token, taskId) => request(app).post(`${ctx.base}/${taskId}/claim`).set(bearer(token)).send({});
const list = (ctx, token, query = '') => request(app).get(`${ctx.base}${query}`).set(bearer(token));

describe('assigning a task', () => {
  it('lets a manager assign and unassign, and shows the assignee on the task', async () => {
    const ctx = await setup();
    const [task] = ctx.tasks;

    const res = await assign(ctx, ctx.operator.accessToken, task.id, ctx.agentA.userId);
    expect(res.status).toBe(200);
    expect(res.body.task.assignedTo).toEqual({ id: ctx.agentA.userId, fullName: 'Agent Amal' });
    expect(res.body.task.assignedAt).toBeTruthy();

    const audit = await db.AuditLog.findOne({ where: { entityId: task.id, action: 'confirmation_task.assign' } });
    expect(audit).not.toBeNull();

    const cleared = await unassign(ctx, ctx.operator.accessToken, task.id);
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.assignedTo).toBeNull();
    expect(cleared.body.task.assignedAt).toBeNull();
  });

  it('is a manager-only action', async () => {
    const ctx = await setup();
    const res = await assign(ctx, ctx.agentA.accessToken, ctx.tasks[0].id, ctx.agentA.userId);
    expect(res.status).toBe(403);
    const people = await request(app).get(`${ctx.base}/assignees`).set(bearer(ctx.agentA.accessToken));
    expect(people.status).toBe(403);
  });

  it('refuses a user from another workspace, exactly as it refuses an unknown one', async () => {
    const ctx = await setup();
    const stranger = await registerAndActivate({ fullName: 'Other Owner' });
    await createWorkspace(stranger.accessToken, 'Other Store');

    const res = await assign(ctx, ctx.ownerToken, ctx.tasks[0].id, stranger.userId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');

    const ghost = await assign(ctx, ctx.ownerToken, ctx.tasks[0].id, '00000000-0000-4000-8000-000000000000');
    expect(ghost.status).toBe(422);
    expect(ghost.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');

    const task = await db.ConfirmationTask.findByPk(ctx.tasks[0].id);
    expect(task.assignedToUserId).toBeNull();
  });

  it("refuses a member whose role can't confirm orders", async () => {
    const ctx = await setup();
    const res = await assign(ctx, ctx.ownerToken, ctx.tasks[0].id, ctx.editor.userId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ASSIGNEE_CANNOT_CONFIRM');
  });

  it("never touches another workspace's task", async () => {
    const ctx = await setup();
    const other = await setup();
    const res = await assign(ctx, ctx.ownerToken, other.tasks[0].id, ctx.agentA.userId);
    expect(res.status).toBe(404);
    const task = await db.ConfirmationTask.findByPk(other.tasks[0].id);
    expect(task.assignedToUserId).toBeNull();
  });

  it('lists only the members who can confirm as assignees', async () => {
    const ctx = await setup();
    const res = await request(app).get(`${ctx.base}/assignees`).set(bearer(ctx.operator.accessToken));
    expect(res.status).toBe(200);
    const ids = res.body.assignees.map((a) => a.id).sort();
    // The owner holds '*'; the operator manages orders but cannot confirm; the editor neither.
    expect(ids).toEqual([ctx.auth.userId, ctx.agentA.userId, ctx.agentB.userId].sort());
  });

  it('assigns in bulk, skipping finished tasks and ids from elsewhere', async () => {
    const ctx = await setup();
    await db.ConfirmationTask.update({ status: 'done', outcome: 'confirmed' }, { where: { id: ctx.tasks[1].id } });
    const foreign = '11111111-1111-4111-8111-111111111111';
    const res = await request(app)
      .post(`${ctx.base}/assign`)
      .set(bearer(ctx.ownerToken))
      .send({ taskIds: [ctx.tasks[0].id, ctx.tasks[1].id, foreign], userId: ctx.agentB.userId });
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t) => t.id)).toEqual([ctx.tasks[0].id]);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { taskId: ctx.tasks[1].id, code: 'TASK_ALREADY_DONE' },
        { taskId: foreign, code: 'NOT_FOUND' },
      ])
    );

    const cleared = await request(app)
      .post(`${ctx.base}/assign`)
      .set(bearer(ctx.ownerToken))
      .send({ taskIds: [ctx.tasks[0].id], userId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tasks[0].assignedTo).toBeNull();
  });
});

describe('claiming an assigned task', () => {
  it("keeps another agent's task out of reach, but not the assignee's or an owner's", async () => {
    const ctx = await setup();
    const [task] = ctx.tasks;
    await assign(ctx, ctx.ownerToken, task.id, ctx.agentA.userId);

    const other = await claim(ctx, ctx.agentB.accessToken, task.id);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('TASK_ASSIGNED_TO_OTHER');
    expect(other.body.error.details.assignedTo).toEqual({ id: ctx.agentA.userId, fullName: 'Agent Amal' });

    // Nor from the order page.
    const fromOrder = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.orders[0].id}/confirmation`)
      .set(bearer(ctx.agentB.accessToken))
      .send({});
    expect(fromOrder.status).toBe(403);
    expect(fromOrder.body.error.code).toBe('TASK_ASSIGNED_TO_OTHER');

    const own = await claim(ctx, ctx.agentA.accessToken, task.id);
    expect(own.status).toBe(200);
    await request(app).post(`${ctx.base}/${task.id}/release`).set(bearer(ctx.agentA.accessToken)).send({});

    // The owner manages orders, so an assignment never locks them out.
    const owner = await claim(ctx, ctx.ownerToken, task.id);
    expect(owner.status).toBe(200);
  });

  it('leaves unassigned tasks open to every agent', async () => {
    const ctx = await setup();
    const res = await claim(ctx, ctx.agentB.accessToken, ctx.tasks[1].id);
    expect(res.status).toBe(200);
  });

  it('keeps the assignment when the call goes unanswered, so the same agent calls back', async () => {
    const ctx = await setup();
    const [task] = ctx.tasks;
    await assign(ctx, ctx.ownerToken, task.id, ctx.agentA.userId);
    await claim(ctx, ctx.agentA.accessToken, task.id);
    const res = await request(app)
      .post(`${ctx.base}/${task.id}/outcome`)
      .set(bearer(ctx.agentA.accessToken))
      .send({ outcome: 'unreachable', channel: 'call' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('queued');
    expect(res.body.task.assignedTo.id).toBe(ctx.agentA.userId);
  });
});

describe('queue filters and counts', () => {
  it('filters by me, unassigned and one agent', async () => {
    const ctx = await setup();
    await assign(ctx, ctx.ownerToken, ctx.tasks[0].id, ctx.agentA.userId);

    const mine = await list(ctx, ctx.agentA.accessToken, '?assignedTo=me');
    expect(mine.status).toBe(200);
    expect(mine.body.tasks.map((t) => t.id)).toEqual([ctx.tasks[0].id]);
    expect(mine.body.tasks[0].assignedTo).toEqual({ id: ctx.agentA.userId, fullName: 'Agent Amal' });

    const open = await list(ctx, ctx.agentB.accessToken, '?assignedTo=unassigned');
    expect(open.body.tasks.map((t) => t.id)).toEqual([ctx.tasks[1].id]);

    const byAgent = await list(ctx, ctx.operator.accessToken, `?assignedTo=${ctx.agentA.userId}`);
    expect(byAgent.body.tasks.map((t) => t.id)).toEqual([ctx.tasks[0].id]);

    const everything = await list(ctx, ctx.agentB.accessToken);
    expect(everything.body.tasks).toHaveLength(2);

    const bad = await list(ctx, ctx.agentB.accessToken, '?assignedTo=someone');
    expect(bad.status).toBe(422);

    const counts = await request(app).get(`${ctx.base}/counts`).set(bearer(ctx.agentA.accessToken));
    expect(counts.body.counts).toEqual(expect.objectContaining({ assignedToMe: 1, unassigned: 1 }));
  });
});

describe('attempt channel', () => {
  it('stores the channel on queue outcomes and order-page confirmations, and shows it on the order', async () => {
    const ctx = await setup();
    const [first, second] = ctx.tasks;
    await claim(ctx, ctx.agentA.accessToken, first.id);
    const res = await request(app)
      .post(`${ctx.base}/${first.id}/outcome`)
      .set(bearer(ctx.agentA.accessToken))
      .send({ outcome: 'confirmed', channel: 'whatsapp' });
    expect(res.status).toBe(200);
    expect(res.body.task.attempts[0].channel).toBe('whatsapp');

    const fromOrder = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.orders[1].id}/confirmation`)
      .set(bearer(ctx.agentB.accessToken))
      .send({ channel: 'call' });
    expect(fromOrder.status).toBe(200);
    const attempt = await db.ConfirmationAttempt.findOne({ where: { taskId: second.id } });
    expect(attempt.channel).toBe('call');

    const order = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.orders[0].id}`)
      .set(bearer(ctx.ownerToken));
    expect(order.body.order.confirmationTask.attempts).toEqual([
      expect.objectContaining({ outcome: 'confirmed', channel: 'whatsapp', agent: { id: ctx.agentA.userId, fullName: 'Agent Amal' } }),
    ]);
  });

  it('accepts no channel, and refuses one it does not know', async () => {
    const ctx = await setup();
    const [task] = ctx.tasks;
    await claim(ctx, ctx.agentA.accessToken, task.id);
    const bad = await request(app)
      .post(`${ctx.base}/${task.id}/outcome`)
      .set(bearer(ctx.agentA.accessToken))
      .send({ outcome: 'postponed', channel: 'pigeon' });
    expect(bad.status).toBe(422);
    const none = await request(app)
      .post(`${ctx.base}/${task.id}/outcome`)
      .set(bearer(ctx.agentA.accessToken))
      .send({ outcome: 'postponed' });
    expect(none.status).toBe(200);
    expect(none.body.task.attempts[0].channel).toBeNull();
  });
});

describe('WhatsApp confirmation message', () => {
  const patch = (ctx, token, settings) =>
    request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}`).set(bearer(token)).send({ settings });

  it('is saved into the store settings by someone who manages orders, and cleared with null', async () => {
    const ctx = await setup();
    const text = 'أهلاً {customerName}، بنأكد طلبك رقم {orderNumber} من {store}';
    const res = await patch(ctx, ctx.ownerToken, { confirmation_whatsapp_template: text });
    expect(res.status).toBe(200);
    let ws = await db.Workspace.findByPk(ctx.workspace.id);
    expect(ws.settings.confirmation_whatsapp_template).toBe(text);

    const cleared = await patch(ctx, ctx.ownerToken, { confirmation_whatsapp_template: null });
    expect(cleared.status).toBe(200);
    ws = await db.Workspace.findByPk(ctx.workspace.id);
    expect(ws.settings).not.toHaveProperty('confirmation_whatsapp_template');
  });

  it("is not an Editor's to change, and refuses an overlong message", async () => {
    const ctx = await setup();
    const editor = await patch(ctx, ctx.editor.accessToken, { confirmation_whatsapp_template: 'Hi {customerName}' });
    expect(editor.status).toBe(403);
    const long = await patch(ctx, ctx.ownerToken, { confirmation_whatsapp_template: 'x'.repeat(1001) });
    expect(long.status).toBe(422);
  });
});
