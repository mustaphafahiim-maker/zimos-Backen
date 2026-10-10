'use strict';

// Tracking providers for manual waybills (shipping/trackingProviders, STORE_FEATURES tracking_provider):
// a shipment no connected courier booked is followed through the store's provider (here the sandbox).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const manualTracking = require('../../src/modules/shipping/trackingProviders/manualTracking');

afterEach(() => {
  env.storeFeatures.length = 0;
});

async function orderWithManualShipment(waybillNumber) {
  const ctx = await setupWorkspaceWithProduct();
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  const placed = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `trk-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Tracked', phone: '01017170001' }, paymentMethod: 'cod' });
  const orderId = placed.body.order.id;
  const shipment = await db.Shipment.create({ workspaceId: ctx.workspace.id, orderId, trackingCode: `T${Date.now()}`.slice(0, 16), carrierCode: 'Local Courier', waybillNumber, status: 'created' });
  return { ...ctx, H, orderId, shipment };
}

const sync = (ctx) => request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.orderId}/shipments/${ctx.shipment.id}/sync`).set(ctx.H);

describe('tracking providers', () => {
  it('off: no setting route, the sync button answers as before, the job reads nothing', async () => {
    const ctx = await orderWithManualShipment('TRK-PU-IT-DL');
    expect((await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shipping/tracking-provider`).set(ctx.H).send({ enabled: true, provider: 'sandbox' })).status).toBe(404);
    const res = await sync(ctx);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIPMENT_NOT_CARRIER_MANAGED');
    expect(await manualTracking.pollDue()).toBeNull();
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('created');
  });

  it('on: a manual waybill is followed through the sandbox, by the sync button and by the job', async () => {
    env.storeFeatures.push('tracking_provider');
    const ctx = await orderWithManualShipment('TRK-PU-IT-DL');
    const url = `/api/v1/workspaces/${ctx.workspace.id}/shipping/tracking-provider`;
    expect((await request(app).put(url).set(ctx.H).send({ enabled: true })).status).toBe(422);
    const put = await request(app).put(url).set(ctx.H).send({ enabled: true, provider: 'sandbox' });
    expect(put.status).toBe(200);
    expect(put.body.trackingProvider).toEqual({ enabled: true, provider: 'sandbox' });

    expect((await sync(ctx)).status).toBe(200);
    const delivered = await db.Shipment.findByPk(ctx.shipment.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.trackingState).toMatchObject({ provider: 'sandbox' });
    expect(await db.ShipmentEvent.count({ where: { shipmentId: ctx.shipment.id } })).toBeGreaterThanOrEqual(3);

    const second = await db.Shipment.create({ workspaceId: ctx.workspace.id, orderId: ctx.orderId, trackingCode: `U${Date.now()}`.slice(0, 16), carrierCode: 'Local Courier', waybillNumber: 'TRK-IT', status: 'created' });
    const run = await manualTracking.pollDue();
    expect(run.claimed).toBeGreaterThanOrEqual(1);
    expect((await db.Shipment.findByPk(second.id)).status).toBe('in_transit');
  });
});
