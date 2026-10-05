'use strict';

// WhatsApp Cloud API integration: connect (verified against the Graph API),
// encrypted token, send text/template, inbound webhook with signature, delivery
// statuses and the inbox endpoints. The Graph API is mocked with global.fetch.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = 'EAAG-test-access-token-1234567890';
const APP_SECRET = 'meta-app-secret-for-tests';
const PHONE_ID = '1122334455';

const realFetch = global.fetch;
let sent;

beforeAll(() => {
  process.env.WHATSAPP_GRAPH_BASE = 'https://graph.test/v21.0';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.WHATSAPP_GRAPH_BASE;
});
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const auth = opts.headers && opts.headers.Authorization;
    const ok = auth === `Bearer ${TOKEN}`;
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (!ok) return json(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (String(url).includes('/messages')) {
      const body = JSON.parse(opts.body);
      sent.push(body);
      return json(200, { messages: [{ id: `wamid.${sent.length}` }] });
    }
    return json(200, { display_phone_number: '+20 10 0000 1111', verified_name: 'Nile Store' });
  });
});

async function connected() {
  const ctx = await setupWorkspaceWithProduct();
  const res = await request(app)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/whatsapp/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET });
  expect(res.status).toBe(200);
  return { ...ctx, integration: res.body.integration };
}

function signed(workspaceId, payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return request(app).post(`/api/v1/webhooks/whatsapp/${workspaceId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${sig}`).send(raw);
}

const inbound = (from, id, text) => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Mona' } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
});

describe('WhatsApp integration', () => {
  it('rejects a token the Graph API refuses', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/whatsapp/integration`)
      .set(bearer(auth.accessToken))
      .send({ phoneNumberId: PHONE_ID, accessToken: 'EAAG-wrong-token-000000000000' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WHATSAPP_AUTH_FAILED');
  });

  it('connects, never exposes the token, and stores it encrypted', async () => {
    const { integration, workspace } = await connected();
    expect(integration).toMatchObject({ connected: true, displayPhoneNumber: '+20 10 0000 1111', accessTokenMask: '••••7890', appSecretSet: true });
    expect(JSON.stringify(integration)).not.toContain(TOKEN);
    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id } });
    expect(row.secretsSealed).not.toContain(TOKEN);
  });

  it('verifies the webhook subscription with the verify token', async () => {
    const { integration, workspace } = await connected();
    const ok = await request(app)
      .get(`/api/v1/webhooks/whatsapp/${workspace.id}`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': integration.webhook.verifyToken, 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app).get(`/api/v1/webhooks/whatsapp/${workspace.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  it('receives messages (signed), opens the 24h window, replies and tracks delivery', async () => {
    const { auth, workspace } = await connected();

    const unsigned = await request(app).post(`/api/v1/webhooks/whatsapp/${workspace.id}`).send(inbound('201055551234', 'wamid.in1', 'hi'));
    expect(unsigned.status).toBe(401);

    // Text outside the 24h window is refused.
    const closed = await request(app).post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`).set(bearer(auth.accessToken)).send({ to: '01055551234', text: 'hello' });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');

    const hook = await signed(workspace.id, inbound('201055551234', 'wamid.in1', 'عايز أسأل عن الطلب'));
    expect(hook.status).toBe(200);
    expect(hook.body.messages).toBe(1);
    // Duplicate delivery of the same webhook is ignored.
    await signed(workspace.id, inbound('201055551234', 'wamid.in1', 'عايز أسأل عن الطلب'));

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations`).set(bearer(auth.accessToken));
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0]).toMatchObject({ customerName: 'Mona', unreadCount: 1, canReply: true });
    const conversationId = list.body.conversations[0].id;

    const reply = await request(app).post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`).set(bearer(auth.accessToken)).send({ to: '01055551234', text: 'أهلًا يا منى' });
    expect(reply.status).toBe(201);
    expect(sent[0]).toMatchObject({ to: '201055551234', type: 'text', text: { body: 'أهلًا يا منى' } });

    await signed(workspace.id, { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'read' }] } }] }] });

    const messages = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations/${conversationId}/messages`).set(bearer(auth.accessToken));
    expect(messages.body.messages.map((m) => [m.direction, m.status])).toEqual([
      ['in', 'received'],
      ['out', 'read'],
    ]);
    const after = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations`).set(bearer(auth.accessToken));
    expect(after.body.conversations[0].unreadCount).toBe(0);
  });

  it('sends approved templates without an open window', async () => {
    const { auth, workspace } = await connected();
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`)
      .set(bearer(auth.accessToken))
      .send({ to: '01099990000', template: { name: 'order_confirmation', language: 'ar', params: ['منى', '1024'] } });
    expect(res.status).toBe(201);
    expect(sent[0]).toMatchObject({ type: 'template', template: { name: 'order_confirmation', language: { code: 'ar' } } });
  });
});
