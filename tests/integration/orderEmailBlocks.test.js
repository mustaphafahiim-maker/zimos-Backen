'use strict';

// The block designer for order emails (notifications/emailBlocks.js, STORE_FEATURES email_blocks).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const orderEmails = require('../../src/modules/notifications/orderEmailService');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const blocks = [
  { type: 'heading', text: 'Thanks {{customer_name}}!' },
  { type: 'text', text: 'Your order <b>{{order_number}}</b> is in.' },
  { type: 'order_table' },
  { type: 'button', label: 'Track it', url: '{{order_link}}' },
  { type: 'divider' },
];

async function store() {
  const ctx = await setupWorkspaceWithProduct();
  return { ...ctx, H: { Authorization: `Bearer ${ctx.auth.accessToken}` }, url: `/api/v1/workspaces/${ctx.workspace.id}/order-emails/order_confirmation` };
}

describe('order email blocks', () => {
  it('off: blocks sent to the API are not stored, shown or used', async () => {
    const { H, url, workspace } = await store();
    const res = await request(app).put(url).set(H).send({ isEnabled: true, blocks });
    expect(res.status).toBe(200);
    expect(res.body.template.blocks).toBeUndefined();
    const row = await db.OrderEmailTemplate.findOne({ where: { workspaceId: workspace.id, key: 'order_confirmation' } });
    expect(row.blocks).toBeNull();
    const preview = await request(app).post(`${url}/preview`).set(H).send({ blocks });
    expect(preview.body.html).not.toContain('Track it');
  });

  it('on: stored, previewed with sample lines, and sent with the order table; text is escaped', async () => {
    env.storeFeatures.push('email_blocks');
    const { H, url, workspace, variant } = await store();

    expect((await request(app).put(url).set(H).send({ blocks: [{ type: 'text' }, { type: 'button', label: 'Go', url: 'javascript:alert(1)' }] })).status).toBe(422);
    const saved = await request(app).put(url).set(H).send({ isEnabled: true, blocks });
    expect(saved.status).toBe(200);
    expect(saved.body.template).toMatchObject({ isCustomised: true, blocks });

    const preview = await request(app).post(`${url}/preview`).set(H).send({});
    expect(preview.body.html).toContain('Thanks منى أحمد!');
    expect(preview.body.html).toContain('حزام جلد');
    expect(preview.body.html).toContain('&lt;b&gt;ORD-1042&lt;/b&gt;');
    expect(preview.body.html).not.toContain('<b>ORD-1042</b>');

    const email = jest.spyOn(notify, 'email');
    const placed = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', `blk-${Date.now()}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .send({ item: { variantId: variant.id, quantity: 2 }, contact: { fullName: 'Mona', phone: '01077770001', email: 'mona@example.com' }, paymentMethod: 'cod' });
    expect(placed.status).toBe(201);
    await orderEmails.handleEvent(workspace.id, 'order.created', { orderId: placed.body.order.id });
    const sent = email.mock.calls.map(([o]) => o).find((o) => o.template === 'order_email');
    expect(sent.data.bodyHtml).toContain('Thanks Mona!');
    expect(sent.data.bodyText).toMatch(/× 2/);

    // Back to the plain body.
    const cleared = await request(app).put(url).set(H).send({ blocks: null });
    expect(cleared.body.template.blocks).toBeNull();
  });
});
