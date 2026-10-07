'use strict';

// The store logo is a URL the merchant types and the waybill is drawn on our
// server: saving a private address is refused, a stored one is never
// fetched, a redirect is never followed, and a real logo still prints.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const { pngWithAlpha } = require('../helpers/images');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const waybillService = require('../../src/modules/waybill/waybillService');
const { fetchLogo, LOGO_MAX_BYTES } = require('../../src/modules/workspaces/workspaceLogo');
const cartService = require('../../src/modules/cart/cartService');
const { UPLOAD_ROOT } = require('../../src/modules/media/storage/localStorage');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const INTERNAL = [
  'http://127.0.0.1/logo.png',
  'http://localhost:4000/logo.png',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.5/logo.png',
  'http://192.168.1.10/logo.png',
  'http://postgres.railway.internal/logo.png',
  'http://[::1]/logo.png',
];

// A loopback server that counts its hits; `handler` answers each request.
async function startServer(handler) {
  const server = http.createServer((req, res) => {
    server.hits += 1;
    handler(req, res);
  });
  server.hits = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  return server;
}
const stop = (server) => new Promise((resolve) => server.close(resolve));

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `wl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Logo Buyer', phone: '01000008888' },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Cairo', addressLine: '8 Logo St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const imageCount = (pdf) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

let savedAllowPrivate;
beforeEach(() => {
  savedAllowPrivate = env.webhooks.allowPrivateUrls;
});
afterEach(() => {
  env.webhooks.allowPrivateUrls = savedAllowPrivate;
});

describe('saving a logo URL', () => {
  it('refuses an internal address with 422, on both the settings and the branding routes', async () => {
    env.webhooks.allowPrivateUrls = false;
    const { auth, workspace } = await setupWorkspaceWithProduct();
    for (const logoUrl of INTERNAL) {
      const res = await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set(bearer(auth.accessToken)).send({ logoUrl });
      expect([logoUrl, res.status]).toEqual([logoUrl, 422]);
      expect(res.body.error.details[0].field).toBe('logoUrl');
    }
    const branding = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/quickstart/branding`)
      .set(bearer(auth.accessToken))
      .send({ logoUrl: 'http://169.254.169.254/latest/meta-data/' });
    expect(branding.status).toBe(422);

    const row = await db.Workspace.findByPk(workspace.id);
    expect(row.logoUrl).toBeNull();
  });

  it('still saves a public URL (http or https) and clears with an empty value', async () => {
    env.webhooks.allowPrivateUrls = false;
    const { auth, workspace } = await setupWorkspaceWithProduct();
    for (const logoUrl of ['https://cdn.example.com/logo.png', 'http://example.com/logo.jpg']) {
      const res = await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set(bearer(auth.accessToken)).send({ logoUrl });
      expect(res.status).toBe(200);
      expect((await db.Workspace.findByPk(workspace.id)).logoUrl).toBe(logoUrl);
    }
    const cleared = await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set(bearer(auth.accessToken)).send({ logoUrl: '' });
    expect(cleared.status).toBe(200);
    expect((await db.Workspace.findByPk(workspace.id)).logoUrl).toBeNull();
  });
});

describe('reading the logo for a waybill', () => {
  it('never requests an internal logo URL saved before the check existed', async () => {
    const png = await pngWithAlpha();
    const server = await startServer((req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
    try {
      env.webhooks.allowPrivateUrls = false;
      const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
      await db.Workspace.update({ logoUrl: server.url('/logo.png') }, { where: { id: workspace.id } });
      const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

      const pdf = await waybillService.generateWaybillPdf(workspace.id, order.id);
      expect(pdf.slice(0, 5).toString('latin1')).toBe('%PDF-');
      expect(await fetchLogo(`http://localhost:${server.address().port}/logo.png`)).toBeNull();
      expect(server.hits).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('does not follow a redirect, even to an address it could reach', async () => {
    const png = await pngWithAlpha();
    const target = await startServer((req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
    const bouncer = await startServer((req, res) => res.writeHead(302, { location: target.url('/logo.png') }).end());
    try {
      // Loopback allowed here (as outside production) so the bounce is reachable.
      env.webhooks.allowPrivateUrls = true;
      expect(await fetchLogo(bouncer.url('/logo.png'))).toBeNull();
      expect(bouncer.hits).toBe(1);
      expect(target.hits).toBe(0);
    } finally {
      await stop(bouncer);
      await stop(target);
    }
  });

  it('keeps only a PNG or JPEG under the size cap', async () => {
    const big = Buffer.alloc(LOGO_MAX_BYTES + 1, 0x89);
    const server = await startServer((req, res) => {
      if (req.url === '/svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
      if (req.url === '/lying') return res.writeHead(200, { 'content-type': 'image/png' }).end('<html>not a png</html>');
      return res.writeHead(200, { 'content-type': 'image/png' }).end(big);
    });
    try {
      env.webhooks.allowPrivateUrls = true;
      expect(await fetchLogo(server.url('/svg'))).toBeNull();
      expect(await fetchLogo(server.url('/lying'))).toBeNull();
      expect(await fetchLogo(server.url('/big'))).toBeNull();
    } finally {
      await stop(server);
    }
  });

  it('prints a reachable PNG logo', async () => {
    const png = await pngWithAlpha();
    const server = await startServer((req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
    try {
      env.webhooks.allowPrivateUrls = true;
      const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
      const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
      const without = await waybillService.generateWaybillPdf(workspace.id, order.id);

      await db.Workspace.update({ logoUrl: server.url('/logo.png') }, { where: { id: workspace.id } });
      const withLogo = await waybillService.generateWaybillPdf(workspace.id, order.id);
      expect(server.hits).toBe(1);
      expect(imageCount(withLogo)).toBeGreaterThan(imageCount(without));
    } finally {
      await stop(server);
    }
  });

  it('reads a logo we host from storage, with no request at all', async () => {
    env.webhooks.allowPrivateUrls = false;
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const dir = path.join(UPLOAD_ROOT, workspace.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'logo.png'), await pngWithAlpha());
    try {
      const logoUrl = `${env.appUrl.replace(/\/$/, '')}/uploads/${workspace.id}/logo.png`;
      const logo = await fetchLogo(logoUrl);
      expect(Buffer.isBuffer(logo)).toBe(true);

      const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
      const without = await waybillService.generateWaybillPdf(workspace.id, order.id);
      await db.Workspace.update({ logoUrl }, { where: { id: workspace.id } });
      const withLogo = await waybillService.generateWaybillPdf(workspace.id, order.id);
      expect(imageCount(withLogo)).toBeGreaterThan(imageCount(without));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cartService.markConverted', () => {
  it('only converts a cart of the given workspace', async () => {
    const a = await setupWorkspaceWithProduct();
    const b = await setupWorkspaceWithProduct();
    const cart = await db.Cart.create({ workspaceId: a.workspace.id, guestToken: `g-${Date.now()}` });

    await cartService.markConverted(b.workspace.id, cart.id, null);
    expect((await cart.reload()).status).toBe('active');

    await cartService.markConverted(a.workspace.id, cart.id, null);
    expect((await cart.reload()).status).toBe('converted');
  });
});
