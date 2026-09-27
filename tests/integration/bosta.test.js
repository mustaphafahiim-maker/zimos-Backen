'use strict';

// Bosta (Egypt courier): connect (API key verified against Bosta's real
// GET /pickup-locations), encrypted + masked credentials, booking a real
// delivery from createShipment (carrierCode: 'bosta') instead of the
// hand-typed manual waybill, the on-demand "refresh" poll, and the
// Authorization-header-secured status webhook (Bosta has no HMAC). Bosta is
// mocked with global.fetch — see src/modules/shipping/carriers/bostaCarrier.js
// for the confirmed request/response shapes this mock plays back.

const express = require('express');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const bostaRoutes = require('../../src/modules/shipping/bostaRoutes');
const secretBox = require('../../src/core/utils/secretBox');
const db = require('../../src/db/models');

// Same mounts as the lines to add to src/app.js; everything else falls
// through to the real app (orders/shipments already live there).
const server = express();
server.use(express.json());
server.use('/api/v1/workspaces/:workspaceId/bosta', bostaRoutes.staff);
server.use('/api/v1/webhooks/bosta', bostaRoutes.webhook);
server.use(app);
server.use(errorHandler);

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const API_KEY = 'test-bosta-api-key-0123456789abcdef';
const BUSINESS_LOCATION = { _id: 'LOC001', locationName: 'Main Warehouse', isDefault: true };
// Stubbed cities/districts — shapes confirmed against Bosta's OpenAPI spec
// (see bostaCarrier.js#listCities/listDistricts doc comments).
const CAIRO_CITY = { _id: 'FceDyHXwpSYYF9zGW', name: 'Cairo', code: 'EG-01' };
const CAIRO_DISTRICT = { zoneId: 'g3jl3V8FMN', zoneName: 'New Cairo', districtId: 'wY_JL43TilR', districtName: '1st Settlement - District 10' };

const realFetch = global.fetch;
let calls;
let trackingSeq;
let deliveryState; // trackingNumber -> { code, value }

beforeAll(() => {
  process.env.BOSTA_API_BASE = 'https://bosta.test/api/v2';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.BOSTA_API_BASE;
});
beforeEach(() => {
  calls = [];
  trackingSeq = 500000;
  deliveryState = new Map();
  global.fetch = jest.fn(async (url, opts = {}) => {
    const path = String(url).replace('https://bosta.test/api/v2', '');
    const auth = opts.headers && opts.headers.Authorization;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method: opts.method || 'GET', body, auth });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });

    if (auth !== API_KEY) {
      return json(401, { success: false, message: 'User is not authorized!', errorCode: 1007, data: null });
    }
    if (path === '/pickup-locations') {
      return json(200, { success: true, message: 'Done successfully.', data: { total: 1, list: [BUSINESS_LOCATION], page: 1, limit: 50, pages: 1 } });
    }
    if (path === '/cities') {
      return json(200, { success: true, message: 'Done successfully.', data: { list: [CAIRO_CITY] } });
    }
    if (path === `/cities/${CAIRO_CITY._id}/districts`) {
      return json(200, { success: true, message: 'Done successfully.', data: [CAIRO_DISTRICT] });
    }
    if (path === '/deliveries?apiVersion=1' && opts.method === 'POST') {
      const trackingNumber = String(++trackingSeq);
      deliveryState.set(trackingNumber, { code: 10, value: 'Pickup requested' });
      return json(200, {
        success: true,
        message: 'Done successfully.',
        data: {
          _id: `del_${trackingNumber}`,
          trackingNumber,
          businessReference: body.businessReference,
          sender: { _id: 'biz1', phone: '+201000000000', name: 'Test Business', type: 'BUSINESS_ACCOUNT' },
          message: 'Delivery created successfully!',
          state: deliveryState.get(trackingNumber),
          creationSrc: 'API',
        },
      });
    }
    const trackMatch = path.match(/^\/deliveries\/business\/([^/]+)$/);
    if (trackMatch && opts.method === 'GET') {
      const trackingNumber = trackMatch[1];
      const state = deliveryState.get(trackingNumber) || { code: 10, value: 'Pickup requested' };
      return json(200, { success: true, message: 'Done successfully.', data: { _id: `del_${trackingNumber}`, trackingNumber, state } });
    }
    return json(404, { success: false, message: 'not mocked', errorCode: 0, data: null });
  });
});

async function connected() {
  const ctx = await setupWorkspaceWithProduct({ price: 25000, stock: 20 });
  const res = await request(server)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/bosta/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ apiKey: API_KEY });
  expect(res.status).toBe(200);
  calls = []; // only each test's own Bosta calls from here on
  return { ...ctx, integration: res.body.integration };
}

async function placeOrder(token, workspaceId, variantId, { paymentMethod = 'cod' } = {}) {
  const res = await request(server)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `bosta-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Aya Mostafa', phone: '01055551234', email: 'aya@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '15 Tahrir Square', province: 'Cairo' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

function createBostaShipment(token, workspaceId, orderId, extra = {}) {
  return request(server)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`)
    .set(bearer(token))
    .send({ carrierCode: 'bosta', ...extra });
}

async function webhookSecretFor(workspaceId) {
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: 'bosta' } });
  return JSON.parse(secretBox.open(row.secretsSealed)).webhookSecret;
}

describe('Bosta integration', () => {
  it('rejects an API key Bosta refuses and stores nothing', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(server)
      .put(`/api/v1/workspaces/${workspace.id}/bosta/integration`)
      .set(bearer(auth.accessToken))
      .send({ apiKey: 'wrong-key-0000000000000000000000' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BOSTA_AUTH_FAILED');
    expect(await db.WorkspaceIntegration.count({ where: { workspaceId: workspace.id, provider: 'bosta' } })).toBe(0);
  });

  it('connects, reads back masked, stores encrypted, and disconnects', async () => {
    const { auth, workspace, integration } = await connected();
    expect(integration).toMatchObject({
      connected: true,
      status: 'connected',
      apiKeyMask: `••••${API_KEY.slice(-4)}`,
      businessLocationId: BUSINESS_LOCATION._id,
      businessLocationName: BUSINESS_LOCATION.locationName,
      lastError: null,
    });
    expect(integration.lastVerifiedAt).toBeTruthy();
    expect(integration.webhook.url).toContain(`/api/v1/webhooks/bosta/${workspace.id}`);
    expect(JSON.stringify(integration)).not.toContain(API_KEY);

    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id, provider: 'bosta' } });
    expect(row.secretsSealed).not.toContain(API_KEY);
    expect(JSON.stringify(row.config)).not.toContain(API_KEY);

    const read = await request(server).get(`/api/v1/workspaces/${workspace.id}/bosta/integration`).set(bearer(auth.accessToken));
    expect(read.status).toBe(200);
    expect(read.body.integration).toMatchObject({ connected: true, apiKeyMask: `••••${API_KEY.slice(-4)}` });
    expect(JSON.stringify(read.body)).not.toContain(API_KEY);

    const gone = await request(server).delete(`/api/v1/workspaces/${workspace.id}/bosta/integration`).set(bearer(auth.accessToken));
    expect(gone.body).toEqual({ disconnected: true });
    const after = await request(server).get(`/api/v1/workspaces/${workspace.id}/bosta/integration`).set(bearer(auth.accessToken));
    expect(after.body.integration).toEqual({ connected: false });
  });

  it('books a real delivery with Bosta and stores the waybill/tracking it returns, not hand-typed data', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await createBostaShipment(auth.accessToken, workspace.id, order.id);
    expect(res.status).toBe(201);
    expect(res.body.shipment).toMatchObject({ carrierCode: 'bosta', status: 'created' });
    expect(res.body.shipment.waybillNumber).toBeTruthy();
    expect(res.body.shipment.carrierResponse).toMatchObject({ trackingNumber: res.body.shipment.waybillNumber });

    const createCall = calls.find((c) => c.path === '/deliveries?apiVersion=1');
    expect(createCall).toBeTruthy();
    expect(createCall.body).toMatchObject({
      type: 10,
      cod: Number(order.totalAmount),
      dropOffAddress: { city: 'Cairo', firstLine: '15 Tahrir Square' },
      receiver: { firstName: 'Aya', lastName: 'Mostafa', phone: '01055551234' },
      businessLocationId: BUSINESS_LOCATION._id,
    });
    expect(createCall.body.webhookUrl).toContain(`/webhooks/bosta/${workspace.id}`);
    expect(createCall.body.webhookCustomHeaders.Authorization).toBeTruthy();

    const row = await db.Shipment.findByPk(res.body.shipment.id);
    expect(row.waybillNumber).toBe(res.body.shipment.waybillNumber);
    expect(row.carrierCode).toBe('bosta');
  });

  it('passes a staff-picked bostaDistrictId through to Bosta dropOffAddress.districtId', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await createBostaShipment(auth.accessToken, workspace.id, order.id, { bostaDistrictId: CAIRO_DISTRICT.districtId });
    expect(res.status).toBe(201);

    const createCall = calls.find((c) => c.path === '/deliveries?apiVersion=1');
    expect(createCall.body.dropOffAddress).toMatchObject({ city: 'Cairo', districtId: CAIRO_DISTRICT.districtId });
  });

  it('omitting bostaDistrictId still books exactly as before (no districtId on dropOffAddress)', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await createBostaShipment(auth.accessToken, workspace.id, order.id);
    expect(res.status).toBe(201);

    const createCall = calls.find((c) => c.path === '/deliveries?apiVersion=1');
    expect(createCall.body.dropOffAddress).not.toHaveProperty('districtId');
  });

  it('lists Bosta cities and, for one, its districts, for the staff-side district picker', async () => {
    const { auth, workspace } = await connected();

    const cities = await request(server).get(`/api/v1/workspaces/${workspace.id}/bosta/cities`).set(bearer(auth.accessToken));
    expect(cities.status).toBe(200);
    expect(cities.body.cities).toEqual([CAIRO_CITY]);

    const districts = await request(server)
      .get(`/api/v1/workspaces/${workspace.id}/bosta/cities/${CAIRO_CITY._id}/districts`)
      .set(bearer(auth.accessToken));
    expect(districts.status).toBe(200);
    expect(districts.body.districts).toEqual([CAIRO_DISTRICT]);

    // Repeated calls within the TTL are served from the in-process cache —
    // no second /cities hit on Bosta.
    const citiesCallCount = calls.filter((c) => c.path === '/cities').length;
    const again = await request(server).get(`/api/v1/workspaces/${workspace.id}/bosta/cities`).set(bearer(auth.accessToken));
    expect(again.status).toBe(200);
    expect(calls.filter((c) => c.path === '/cities')).toHaveLength(citiesCallCount);
  });

  it('the cities/districts picker is quietly empty (not an error) when Bosta is not connected', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();

    const cities = await request(server).get(`/api/v1/workspaces/${workspace.id}/bosta/cities`).set(bearer(auth.accessToken));
    expect(cities.status).toBe(200);
    expect(cities.body.cities).toEqual([]);

    const districts = await request(server)
      .get(`/api/v1/workspaces/${workspace.id}/bosta/cities/${CAIRO_CITY._id}/districts`)
      .set(bearer(auth.accessToken));
    expect(districts.status).toBe(200);
    expect(districts.body.districts).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refuses to create a Bosta shipment when Bosta is not connected, and creates nothing', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await createBostaShipment(auth.accessToken, workspace.id, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BOSTA_NOT_CONNECTED');
    expect(calls).toHaveLength(0);
    expect(await db.Shipment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('the on-demand refresh polls Bosta and advances the order through the existing fulfillment mapping', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const shipment = (await createBostaShipment(auth.accessToken, workspace.id, order.id)).body.shipment;

    // Advance the mocked Bosta delivery to "Delivered" (state code 45).
    deliveryState.set(shipment.waybillNumber, { code: 45, value: 'Delivered' });

    const refreshRes = await request(server)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${shipment.id}/refresh`)
      .set(bearer(auth.accessToken))
      .send();
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.shipment.status).toBe('delivered');

    const updatedOrder = await db.Order.findByPk(order.id);
    expect(updatedOrder.fulfillmentState).toBe('fulfilled');
  });

  it('refresh is refused for a manual-carrier shipment (nothing to poll)', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const manual = await request(server)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'manual', waybillNumber: 'MANUAL-1' });

    const res = await request(server)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${manual.body.shipment.id}/refresh`)
      .set(bearer(auth.accessToken))
      .send();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHIPMENT_NOT_REMOTE');
  });

  it('the status webhook is rejected without the right Authorization header, and otherwise moves the order through the fulfillment mapping', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const shipment = (await createBostaShipment(auth.accessToken, workspace.id, order.id)).body.shipment;
    const secret = await webhookSecretFor(workspace.id);

    const wrong = await request(server)
      .post(`/api/v1/webhooks/bosta/${workspace.id}`)
      .set('Authorization', 'not-the-secret')
      .send({ trackingNumber: shipment.waybillNumber, state: 41 });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_SIGNATURE');
    let unchanged = await db.Shipment.findByPk(shipment.id);
    expect(unchanged.status).toBe('created');

    // state 41 ("Picked up" / heading to customer) -> out_for_delivery -> partially_fulfilled
    const outForDelivery = await request(server)
      .post(`/api/v1/webhooks/bosta/${workspace.id}`)
      .set('Authorization', secret)
      .send({ trackingNumber: shipment.waybillNumber, state: 41, type: 'SEND', timeStamp: Date.now(), businessReference: order.orderNumber, numberOfAttempts: 0 });
    expect(outForDelivery.status).toBe(200);
    expect(outForDelivery.body.status).toBe('out_for_delivery');
    expect((await db.Order.findByPk(order.id)).fulfillmentState).toBe('partially_fulfilled');

    // state 45 (Delivered) -> delivered -> fulfilled
    const delivered = await request(server)
      .post(`/api/v1/webhooks/bosta/${workspace.id}`)
      .set('Authorization', secret)
      .send({ trackingNumber: shipment.waybillNumber, state: 45, type: 'SEND', timeStamp: Date.now(), cod: Number(order.totalAmount), businessReference: order.orderNumber, numberOfAttempts: 0 });
    expect(delivered.status).toBe(200);
    expect(delivered.body.status).toBe('delivered');

    const finalOrder = await db.Order.findByPk(order.id);
    expect(finalOrder.fulfillmentState).toBe('fulfilled');
    const finalShipment = await db.Shipment.findByPk(shipment.id);
    expect(finalShipment.status).toBe('delivered');
    expect(finalShipment.deliveredAt).toBeTruthy();
    expect(finalShipment.carrierResponse).toMatchObject({ state: 45 });
  });

  it('an unknown tracking number is ignored rather than crashing', async () => {
    const { workspace } = await connected();
    const secret = await webhookSecretFor(workspace.id);
    const res = await request(server)
      .post(`/api/v1/webhooks/bosta/${workspace.id}`)
      .set('Authorization', secret)
      .send({ trackingNumber: 'does-not-exist', state: 45 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: 'unknown_shipment' });
  });

  it('leaves manual-carrier shipment creation completely unaffected, even while Bosta is connected', async () => {
    const { auth, workspace, variant } = await connected();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await request(server)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'manual', waybillNumber: 'MANUAL-12345', trackingUrl: 'https://example.com/track/12345' });
    expect(res.status).toBe(201);
    expect(res.body.shipment).toMatchObject({
      carrierCode: 'manual',
      waybillNumber: 'MANUAL-12345',
      trackingUrl: 'https://example.com/track/12345',
      status: 'created',
    });
    expect(calls).toHaveLength(0);
  });
});
