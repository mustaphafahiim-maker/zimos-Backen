'use strict';

// Server-side ad-platform conversions (Meta CAPI, TikTok Events API,
// Snapchat CAPI, GA4 Measurement Protocol) for orders: the "server_pixels"
// integration (connect/read/disconnect, masked, encrypted — same shape as
// paymob.test.js/bosta.test.js) and marketing/pixelEvents.js firing
// unconditionally on order.created for whichever platforms have BOTH a
// public pixel id (workspaces.settings.tracking_pixels) and a secret
// configured. All four platforms are mocked with global.fetch — see
// src/modules/marketing/pixelProviders/*.js for the confirmed request shapes
// this mock plays back.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const META_PIXEL = '1234567890123';
const META_TOKEN = 'EAAG-meta-capi-token-0123456789';
const TIKTOK_PIXEL = 'ABCDEFGHIJ1234';
const TIKTOK_TOKEN = 'tiktok-capi-token-0123456789';
const SNAP_PIXEL = '11111111-2222-3333-4444-555555555555';
const SNAP_TOKEN = 'snapchat-capi-token-0123456789';
const GOOGLE_TAG = 'G-ABCD1234';
const GOOGLE_SECRET = 'google-mp-api-secret-012345';

const ALL_PIXELS = { meta: META_PIXEL, tiktok: TIKTOK_PIXEL, snapchat: SNAP_PIXEL, google_tag: GOOGLE_TAG };
const ALL_SECRETS = { metaAccessToken: META_TOKEN, tiktokAccessToken: TIKTOK_TOKEN, snapchatAccessToken: SNAP_TOKEN, googleApiSecret: GOOGLE_SECRET };

const realFetch = global.fetch;
let calls;
let failPlatform; // set by a test to make that platform's call fail

function jsonRes(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

beforeEach(() => {
  calls = [];
  failPlatform = null;
  global.fetch = jest.fn(async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method, body, headers: opts.headers || {} });

    if (u.includes('graph.facebook.com')) {
      if (failPlatform === 'meta') return jsonRes(500, { error: { message: 'Meta is down' } });
      return jsonRes(200, { events_received: 1, fbtrace_id: 'trace-meta' });
    }
    if (u.includes('business-api.tiktok.com')) {
      if (failPlatform === 'tiktok') return jsonRes(200, { code: 40001, message: 'Invalid Access-Token' });
      return jsonRes(200, { code: 0, message: 'OK', data: {} });
    }
    if (u.includes('tr.snapchat.com')) {
      if (failPlatform === 'snapchat') return jsonRes(401, { message: 'invalid access token' });
      return jsonRes(200, { request_status: 'success' });
    }
    if (u.includes('google-analytics.com')) {
      if (failPlatform === 'google') return jsonRes(403, { error: 'forbidden' });
      return jsonRes(204, null);
    }
    return jsonRes(404, { message: 'not mocked' });
  });
});
afterAll(() => {
  global.fetch = realFetch;
});

async function waitForCallCount(n) {
  for (let i = 0; i < 40; i += 1) {
    if (calls.length >= n) return calls;
    await new Promise((r) => setTimeout(r, 100));
  }
  return calls;
}

async function setPixels(token, workspaceId, pixels) {
  const res = await request(app)
    .patch(`/api/v1/workspaces/${workspaceId}`)
    .set(bearer(token))
    .send({ settings: { tracking_pixels: pixels } });
  if (res.status !== 200) throw new Error(`setPixels failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function putServerPixels(token, workspaceId, secrets) {
  return request(app).put(`/api/v1/workspaces/${workspaceId}/server-pixels/integration`).set(bearer(token)).send(secrets);
}

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `pixel-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Nour Hassan', phone: '01055559999', email: 'nour@example.com' },
      shippingAddress: { country: 'EG', city: 'Giza', addressLine: '9 Pyramids Road', province: 'Giza' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('server_pixels integration (connect/read/disconnect)', () => {
  it('connects, reads back masked, stores encrypted, and disconnects', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();

    const connectRes = await putServerPixels(auth.accessToken, workspace.id, ALL_SECRETS);
    expect(connectRes.status).toBe(200);
    expect(connectRes.body.integration).toMatchObject({
      connected: true,
      platforms: {
        meta: { configured: true, accessTokenMask: `••••${META_TOKEN.slice(-4)}`, testEventCodeSet: false },
        tiktok: { configured: true, accessTokenMask: `••••${TIKTOK_TOKEN.slice(-4)}` },
        snapchat: { configured: true, accessTokenMask: `••••${SNAP_TOKEN.slice(-4)}` },
        google: { configured: true, apiSecretMask: `••••${GOOGLE_SECRET.slice(-4)}` },
      },
    });
    expect(JSON.stringify(connectRes.body)).not.toContain(META_TOKEN);
    expect(JSON.stringify(connectRes.body)).not.toContain(TIKTOK_TOKEN);

    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id, provider: 'server_pixels' } });
    expect(row.secretsSealed).not.toContain(META_TOKEN);
    expect(row.secretsSealed).not.toContain(GOOGLE_SECRET);

    const readRes = await request(app).get(`/api/v1/workspaces/${workspace.id}/server-pixels/integration`).set(bearer(auth.accessToken));
    expect(readRes.status).toBe(200);
    expect(readRes.body.integration.platforms.meta.configured).toBe(true);

    // Clearing just Meta (empty string) leaves the other three untouched.
    const clearMeta = await putServerPixels(auth.accessToken, workspace.id, { metaAccessToken: '' });
    expect(clearMeta.status).toBe(200);
    expect(clearMeta.body.integration.platforms.meta.configured).toBe(false);
    expect(clearMeta.body.integration.platforms.tiktok.configured).toBe(true);

    const disconnectRes = await request(app).delete(`/api/v1/workspaces/${workspace.id}/server-pixels/integration`).set(bearer(auth.accessToken));
    expect(disconnectRes.body).toEqual({ disconnected: true });
    const afterRes = await request(app).get(`/api/v1/workspaces/${workspace.id}/server-pixels/integration`).set(bearer(auth.accessToken));
    expect(afterRes.body.integration.connected).toBe(false);
  });
});

describe('pixelEvents on order.created', () => {
  it('calls all four platforms when all are configured, each with event_id == order.id', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 30000 });
    await setPixels(auth.accessToken, workspace.id, ALL_PIXELS);
    await putServerPixels(auth.accessToken, workspace.id, ALL_SECRETS);
    calls = [];

    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await waitForCallCount(4);

    expect(calls).toHaveLength(4);
    const meta = calls.find((c) => c.url.includes('graph.facebook.com'));
    const tiktok = calls.find((c) => c.url.includes('business-api.tiktok.com'));
    const snap = calls.find((c) => c.url.includes('tr.snapchat.com'));
    const google = calls.find((c) => c.url.includes('google-analytics.com'));
    expect(meta).toBeTruthy();
    expect(tiktok).toBeTruthy();
    expect(snap).toBeTruthy();
    expect(google).toBeTruthy();

    expect(meta.url).toContain(`/${META_PIXEL}/events`);
    expect(meta.url).toContain(`access_token=${META_TOKEN}`);
    expect(meta.body.data[0]).toMatchObject({ event_name: 'Purchase', event_id: order.id, action_source: 'website' });
    expect(meta.body.data[0].custom_data).toMatchObject({ currency: order.currency, value: Number(order.totalAmount) / 100 });
    expect(meta.body.data[0].user_data.em).toBeTruthy();
    expect(meta.body.data[0].user_data.em[0]).not.toBe('nour@example.com');

    expect(tiktok.headers['Access-Token']).toBe(TIKTOK_TOKEN);
    expect(tiktok.body).toMatchObject({ event_source: 'web', event_source_id: TIKTOK_PIXEL });
    expect(tiktok.body.data[0]).toMatchObject({ event: 'CompletePayment', event_id: order.id });

    expect(snap.url).toContain(`/${SNAP_PIXEL}/events`);
    expect(snap.url).toContain(`access_token=${SNAP_TOKEN}`);
    expect(snap.body.data[0]).toMatchObject({ event_name: 'PURCHASE', event_id: order.id, action_source: 'WEB' });

    expect(google.url).toContain(`measurement_id=${GOOGLE_TAG}`);
    expect(google.url).toContain(`api_secret=${GOOGLE_SECRET}`);
    expect(google.body.events[0]).toMatchObject({ name: 'purchase', params: { transaction_id: order.id, currency: order.currency } });

    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id, provider: 'server_pixels' } });
    expect(row.lastError).toBeNull();
  });

  it('calls only the platforms that are configured (public id AND secret both present)', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    // Public id set for meta+tiktok, but only meta gets a secret -> only meta fires.
    await setPixels(auth.accessToken, workspace.id, { meta: META_PIXEL, tiktok: TIKTOK_PIXEL });
    await putServerPixels(auth.accessToken, workspace.id, { metaAccessToken: META_TOKEN });
    calls = [];

    await placeOrder(auth.accessToken, workspace.id, variant.id);
    await waitForCallCount(1);
    // Give any (incorrect) extra call a moment to show up before asserting length.
    await new Promise((r) => setTimeout(r, 200));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('graph.facebook.com');
  });

  it('calls none of the platforms, and does not error, when server_pixels is not configured at all', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await setPixels(auth.accessToken, workspace.id, ALL_PIXELS);
    // No PUT /server-pixels/integration at all -> no integration row.
    calls = [];

    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await new Promise((r) => setTimeout(r, 300));

    expect(order.id).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(await db.WorkspaceIntegration.count({ where: { workspaceId: workspace.id, provider: 'server_pixels' } })).toBe(0);
  });

  it("a platform's HTTP failure is caught and logged, and never affects order creation or the other platforms", async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await setPixels(auth.accessToken, workspace.id, ALL_PIXELS);
    await putServerPixels(auth.accessToken, workspace.id, ALL_SECRETS);
    calls = [];
    failPlatform = 'tiktok';

    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    expect(order.id).toBeTruthy(); // order creation itself never sees the failure

    await waitForCallCount(4);
    expect(calls).toHaveLength(4); // the other three still ran

    let row;
    for (let i = 0; i < 40; i += 1) {
      row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id, provider: 'server_pixels' } });
      if (row.lastError) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row.lastError).toMatch(/^tiktok:/);
  });

  it('does not fire for order.cancelled (only order.created maps to a purchase conversion)', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await setPixels(auth.accessToken, workspace.id, ALL_PIXELS);
    await putServerPixels(auth.accessToken, workspace.id, ALL_SECRETS);
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await waitForCallCount(4);
    calls = [];

    const cancelRes = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`)
      .set(bearer(auth.accessToken))
      .send({ reason: 'customer changed their mind' });
    expect(cancelRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
  });
});
