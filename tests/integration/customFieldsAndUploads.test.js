'use strict';

// Product custom fields, the photos shoppers upload for them, and the
// processing every uploaded image goes through (merchant media included).

const fs = require('fs');
const path = require('path');
const express = require('express');
const sharp = require('sharp');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const { SECRET, jpegWithExif, pngWithAlpha, gifWithMetadata, corruptJpeg } = require('../helpers/images');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { PRIVATE_ROOT, UPLOAD_ROOT } = require('../../src/modules/media/storage/localStorage');
const { sweepExpiredUploads } = require('../../src/modules/customerUploads/customerUploadService');
const { createUploadLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

const VISITOR = 'visitor-aaaaaaaa';
const OTHER_VISITOR = 'visitor-bbbbbbbb';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

afterAll(() => {
  fs.rmSync(path.join(PRIVATE_ROOT, 'customer-uploads'), { recursive: true, force: true });
  try {
    for (const entry of fs.readdirSync(UPLOAD_ROOT)) {
      if (entry !== '.gitkeep') fs.rmSync(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true });
    }
  } catch {
    /* nothing uploaded */
  }
});

const FIELDS = [
  { id: 'engraving', type: 'text', label: { ar: 'الاسم على المنتج', en: 'Name to engrave' }, required: true, maxLength: 12 },
  { id: 'note', type: 'textarea', label: { ar: 'رسالة', en: 'Message' }, required: false },
  { id: 'photo', type: 'image', label: { ar: 'صورتك', en: 'Your photo' }, required: false },
];

/** A store whose product has the three fields, published. */
async function setup() {
  const ctx = await setupWorkspaceWithProduct({ stock: 50 });
  const ws = ctx.workspace.id;
  const res = await request(app)
    .patch(`/api/v1/workspaces/${ws}/catalog/products/${ctx.product.id}`)
    .set(bearer(ctx.auth.accessToken))
    .send({ status: 'active', customFields: FIELDS });
  if (res.status !== 200) throw new Error(`setup: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...ctx, ws };
}

const upload = (ws, buffer, { visitor = VISITOR, filename = 'photo.jpg', productId } = {}) => {
  const req = request(app).post(`/api/v1/store/${ws}/uploads`);
  if (visitor) req.set('X-Visitor-Id', visitor);
  if (productId) req.field('productId', productId);
  return req.attach('file', buffer, { filename, contentType: 'image/jpeg' });
};

const readPrivate = (key) => fs.readFileSync(path.join(PRIVATE_ROOT, key));

describe('product custom fields', () => {
  it('stores up to five well-formed fields and hands them to the storefront', async () => {
    const ctx = await setup();
    const product = await db.Product.findByPk(ctx.product.id);
    expect(product.customFields).toHaveLength(3);
    const res = await request(app).get(`/api/v1/store/${ctx.ws}/products/${ctx.product.id}`);
    expect(res.body.product.customFields.map((f) => f.id)).toEqual(['engraving', 'note', 'photo']);
  });

  it('refuses malformed definitions', async () => {
    const ctx = await setup();
    const patch = (customFields) =>
      request(app)
        .patch(`/api/v1/workspaces/${ctx.ws}/catalog/products/${ctx.product.id}`)
        .set(bearer(ctx.auth.accessToken))
        .send({ customFields });
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, type: 'text', label: { en: `F${i}` } }));
    expect((await patch(six)).status).toBe(422);
    expect((await patch([{ id: 'p', type: 'image', label: { en: 'P' }, maxLength: 10 }])).status).toBe(422);
    expect((await patch([{ id: 'Bad Id', type: 'text', label: { en: 'X' } }])).status).toBe(422);
    expect((await patch([{ id: 'x', type: 'text', label: { ar: '', en: '' } }])).status).toBe(422);
    expect((await patch([{ id: 'x', type: 'video', label: { en: 'X' } }])).status).toBe(422);
    expect((await patch([{ id: 'x', type: 'text', label: { en: 'A' } }, { id: 'x', type: 'text', label: { en: 'B' } }])).status).toBe(422);
    expect((await patch([{ id: 'x', type: 'text', label: { en: 'X' }, maxLength: 500 }])).status).toBe(422);
  });
});

describe('customer uploads', () => {
  it('turns a phone photo upright, strips every piece of metadata, and stores it privately', async () => {
    const ctx = await setup();
    const res = await upload(ctx.ws, await jpegWithExif(), { productId: ctx.product.id });
    expect(res.status).toBe(201);
    expect(res.body.upload).toEqual(
      expect.objectContaining({ uploadId: expect.any(String), mime: 'image/jpeg', width: 60, height: 120 })
    );
    const row = await db.CustomerUpload.findByPk(res.body.upload.uploadId);
    expect(row.status).toBe('pending');
    expect(row.path).toMatch(new RegExp(`^customer-uploads/${ctx.ws}/[0-9a-f-]{36}\\.jpg$`));
    expect(new Date(row.expiresAt) - Date.now()).toBeGreaterThan(47 * 60 * 60 * 1000);

    const stored = readPrivate(row.path);
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
    expect(stored.includes(Buffer.from(SECRET))).toBe(false);
    // Not in the merchant's library, and not under the public uploads folder.
    expect(await db.MediaAsset.count()).toBe(0);
  });

  it('keeps a transparent PNG as WebP', async () => {
    const ctx = await setup();
    const res = await upload(ctx.ws, await pngWithAlpha(), { filename: 'logo.png' });
    expect(res.status).toBe(201);
    expect(res.body.upload.mime).toBe('image/webp');
  });

  it('decides the type by content and refuses GIF, SVG, text and broken images', async () => {
    const ctx = await setup();
    const gif = await upload(ctx.ws, await gifWithMetadata(), { filename: 'a.jpg' });
    expect(gif.status).toBe(415);
    const svg = await upload(ctx.ws, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { filename: 'a.jpg' });
    expect(svg.status).toBe(415);
    const text = await upload(ctx.ws, Buffer.from('not an image at all'), { filename: 'a.jpg' });
    expect(text.status).toBe(415);
    const broken = await upload(ctx.ws, corruptJpeg());
    expect(broken.status).toBe(422);
    expect(broken.body.error.code).toBe('IMAGE_UNREADABLE');
    expect(await db.CustomerUpload.count()).toBe(0);
  });

  it('refuses a file over 15 MB before processing it', async () => {
    const ctx = await setup();
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(15 * 1024 * 1024 + 10)]);
    const res = await upload(ctx.ws, huge);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('needs a visitor id, and caps how many photos one visitor may leave waiting', async () => {
    const ctx = await setup();
    const none = await upload(ctx.ws, await jpegWithExif(), { visitor: null });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VISITOR_ID_REQUIRED');

    const cap = env.customerUploads.maxPendingPerVisitor;
    env.customerUploads.maxPendingPerVisitor = 2;
    try {
      expect((await upload(ctx.ws, await jpegWithExif())).status).toBe(201);
      expect((await upload(ctx.ws, await jpegWithExif())).status).toBe(201);
      const third = await upload(ctx.ws, await jpegWithExif());
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('TOO_MANY_PENDING_UPLOADS');
      expect((await upload(ctx.ws, await jpegWithExif(), { visitor: OTHER_VISITOR })).status).toBe(201);
    } finally {
      env.customerUploads.maxPendingPerVisitor = cap;
    }
  });

  it('is rate limited per visitor and per IP', async () => {
    const limited = express();
    limited.set('trust proxy', 1);
    limited.post(
      '/up',
      createUploadLimiter({ ipPerMinute: 4, ipPerHour: 100, visitorPerMinute: 2, visitorPerHour: 100 }),
      (req, res) => res.json({ ok: true })
    );
    limited.use(errorHandler);
    const send = (visitor, ip = '203.0.113.9') =>
      request(limited).post('/up').set('X-Forwarded-For', ip).set('X-Visitor-Id', visitor);
    expect((await send('visitor-1111')).status).toBe(200);
    expect((await send('visitor-1111')).status).toBe(200);
    expect((await send('visitor-1111')).status).toBe(429);
    // Rotating visitor ids runs into the IP's own limit.
    expect((await send('visitor-2222')).status).toBe(200);
    expect((await send('visitor-3333')).status).toBe(200);
    expect((await send('visitor-4444')).status).toBe(429);
    expect((await send('visitor-5555', '203.0.113.10')).status).toBe(200);
  });
});

describe('answers in the cart and the order', () => {
  const addToCart = (ctx, token, body, visitor = VISITOR) =>
    request(app)
      .post(`/api/v1/store/${ctx.ws}/cart/items`)
      .set('X-Cart-Token', token)
      .set('X-Visitor-Id', visitor)
      .send({ variantId: ctx.variant.id, quantity: 1, ...body });

  async function newCart(ctx) {
    const res = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
    return res.body.guestToken;
  }

  it('checks every answer against the product as it goes into the cart', async () => {
    const ctx = await setup();
    const token = await newCart(ctx);

    const missing = await addToCart(ctx, token, { customizations: { note: 'hi' } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('CUSTOM_FIELDS_INVALID');
    expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'customizations.engraving', code: 'REQUIRED' })]);

    const unknown = await addToCart(ctx, token, { customizations: { engraving: 'Sara', colour: 'red' } });
    expect(unknown.body.error.details).toEqual([expect.objectContaining({ code: 'UNKNOWN_FIELD' })]);

    const long = await addToCart(ctx, token, { customizations: { engraving: 'A name far too long' } });
    expect(long.body.error.details).toEqual([expect.objectContaining({ code: 'TOO_LONG', max: 12 })]);

    const someoneElses = (await upload(ctx.ws, await jpegWithExif(), { visitor: OTHER_VISITOR })).body.upload.uploadId;
    const stolen = await addToCart(ctx, token, { customizations: { engraving: 'Sara', photo: someoneElses } });
    expect(stolen.body.error.details).toEqual([expect.objectContaining({ field: 'customizations.photo', code: 'UPLOAD_INVALID' })]);

    const ok = await addToCart(ctx, token, { customizations: { engraving: '  Sara\u0007 ', note: 'Happy\nbirthday' } });
    expect(ok.status).toBe(201);
    expect(ok.body.items[0].customizations).toEqual([
      { fieldId: 'engraving', type: 'text', label: { ar: 'الاسم على المنتج', en: 'Name to engrave' }, value: 'Sara' },
      { fieldId: 'note', type: 'textarea', label: { ar: 'رسالة', en: 'Message' }, value: 'Happy\nbirthday' },
    ]);

    // Different answers are a line of their own; the same ones add up.
    await addToCart(ctx, token, { customizations: { engraving: 'Omar' } });
    const again = await addToCart(ctx, token, { customizations: { engraving: 'Sara', note: 'Happy\nbirthday' } });
    expect(again.body.items).toHaveLength(2);
    expect(again.body.items.find((i) => i.customizations[0].value === 'Sara').quantity).toBe(2);
  });

  it('carries the answers and the photo into the order, attaching the photo to its line', async () => {
    const ctx = await setup();
    const token = await newCart(ctx);
    const photo = (await upload(ctx.ws, await jpegWithExif(), { productId: ctx.product.id })).body.upload.uploadId;
    await addToCart(ctx, token, { customizations: { engraving: 'Mona', photo } });

    // Checked out from another tab: a new visitor id, but the photo is in this cart.
    const res = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('X-Cart-Token', token)
      .set('X-Visitor-Id', 'visitor-new-tab-1')
      .set('Idempotency-Key', `cf-${Date.now()}`)
      .send({
        contact: { fullName: 'Mona Ali', phone: '01012345678' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Nile St' },
        paymentMethod: 'cod',
      });
    expect(res.status).toBe(201);
    const [item] = res.body.order.items;
    expect(item.customizations).toEqual([
      expect.objectContaining({ fieldId: 'engraving', value: 'Mona' }),
      expect.objectContaining({ fieldId: 'photo', type: 'image', uploadId: photo }),
    ]);
    const row = await db.CustomerUpload.findByPk(photo);
    expect(row.status).toBe('attached');
    expect(row.orderItemId).toBe(item.id);
    expect(row.expiresAt).toBeNull();

    // Staff see it through a short-lived signed link.
    const order = await request(app).get(`/api/v1/workspaces/${ctx.ws}/orders/${res.body.order.id}`).set(bearer(ctx.auth.accessToken));
    const shown = order.body.order.items[0].customizations.find((c) => c.type === 'image');
    expect(shown.url).toMatch(/\/api\/v1\/customer-uploads\/[0-9a-f-]+\?expires=\d+&signature=[0-9a-f]{64}$/);
    const { pathname, search } = new URL(shown.url);
    const image = await request(app).get(`${pathname}${search}`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(image.headers['cache-control']).toMatch(/^private/);

    const forged = await request(app).get(`${pathname}${search.replace(/signature=[0-9a-f]{4}/, 'signature=0000')}`);
    expect(forged.status).toBe(404);
    const expired = await request(app).get(`${pathname}?expires=1000&${search.split('&')[1]}`);
    expect(expired.status).toBe(404);

    // The photo is not in the order twice: a second order cannot take it.
    const reuse = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('X-Visitor-Id', VISITOR)
      .set('Idempotency-Key', `cf2-${Date.now()}`)
      .send({
        contact: { fullName: 'Mona Ali', phone: '01012345678' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Nile St' },
        paymentMethod: 'cod',
        item: { variantId: ctx.variant.id, quantity: 1, customizations: { engraving: 'Mona', photo } },
      });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('CUSTOM_FIELDS_INVALID');
  });

  it('enforces required answers for a buy-now checkout, but not for staff orders', async () => {
    const ctx = await setup();
    const buyNow = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('Idempotency-Key', `bn-${Date.now()}`)
      .send({
        contact: { fullName: 'Buyer', phone: '01012345679' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '2 Nile St' },
        paymentMethod: 'cod',
        item: { variantId: ctx.variant.id, quantity: 1 },
      });
    expect(buyNow.status).toBe(422);
    expect(buyNow.body.error.details).toEqual([expect.objectContaining({ code: 'REQUIRED' })]);

    const staff = await request(app)
      .post(`/api/v1/workspaces/${ctx.ws}/orders`)
      .set(bearer(ctx.auth.accessToken))
      .set('Idempotency-Key', `st-${Date.now()}`)
      .send({
        items: [{ variantId: ctx.variant.id, quantity: 1 }],
        contact: { fullName: 'Walk-in', phone: '01012345670' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '3 Nile St' },
        paymentMethod: 'cod',
      });
    expect(staff.status).toBe(201);
  });

  it("never accepts another store's photo", async () => {
    const a = await setup();
    const b = await setup();
    const photo = (await upload(a.ws, await jpegWithExif())).body.upload.uploadId;
    const res = await request(app)
      .post(`/api/v1/store/${b.ws}/checkout`)
      .set('X-Visitor-Id', VISITOR)
      .set('Idempotency-Key', `iso-${Date.now()}`)
      .send({
        contact: { fullName: 'Buyer', phone: '01012345671' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '4 Nile St' },
        paymentMethod: 'cod',
        item: { variantId: b.variant.id, quantity: 1, customizations: { engraving: 'X', photo } },
      });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([expect.objectContaining({ code: 'UPLOAD_INVALID' })]);
    expect((await db.CustomerUpload.findByPk(photo)).status).toBe('pending');
  });
});

describe('the sweep', () => {
  it('deletes pending photos past their expiry, from storage and the table, and keeps the rest', async () => {
    const ctx = await setup();
    const old = (await upload(ctx.ws, await jpegWithExif())).body.upload.uploadId;
    const fresh = (await upload(ctx.ws, await jpegWithExif())).body.upload.uploadId;
    const attached = (await upload(ctx.ws, await jpegWithExif())).body.upload.uploadId;
    await db.CustomerUpload.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: [old, attached] } });
    await db.CustomerUpload.update({ status: 'attached' }, { where: { id: attached } });
    const oldPath = (await db.CustomerUpload.findByPk(old)).path;

    expect(await sweepExpiredUploads()).toBe(1);
    expect(await db.CustomerUpload.findByPk(old)).toBeNull();
    expect(fs.existsSync(path.join(PRIVATE_ROOT, oldPath))).toBe(false);
    expect(await db.CustomerUpload.findByPk(fresh)).not.toBeNull();
    expect(await db.CustomerUpload.findByPk(attached)).not.toBeNull();
  });
});

describe('merchant media', () => {
  const uploadMedia = (ctx, buffer, filename) =>
    request(app)
      .post(`/api/v1/workspaces/${ctx.ws}/media`)
      .set(bearer(ctx.auth.accessToken))
      .attach('file', buffer, { filename, contentType: 'application/octet-stream' });
  const onDisk = (p) => fs.readFileSync(path.join(UPLOAD_ROOT, p.replace('/uploads/', '')));

  it('strips EXIF from a JPEG and turns it upright, keeping it a JPEG', async () => {
    const ctx = await setup();
    const res = await uploadMedia(ctx, await jpegWithExif(), 'phone.jpg');
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/jpeg');
    const stored = onDisk(res.body.path);
    expect(res.body.size).toBe(stored.length);
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([60, 120]);
    expect(stored.includes(Buffer.from(SECRET))).toBe(false);
  });

  it('keeps an animated GIF animated, without its comment and XMP', async () => {
    const ctx = await setup();
    const res = await uploadMedia(ctx, await gifWithMetadata(), 'anim.gif');
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/gif');
    const stored = onDisk(res.body.path);
    expect(stored.includes(Buffer.from(SECRET, 'latin1'))).toBe(false);
    expect(stored.includes(Buffer.from('NETSCAPE2.0', 'latin1'))).toBe(true);
    expect((await sharp(stored, { animated: true }).metadata()).pages).toBe(2);
  });

  it('refuses an image that cannot be decoded', async () => {
    const ctx = await setup();
    const res = await uploadMedia(ctx, corruptJpeg(), 'broken.jpg');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMAGE_UNREADABLE');
  });
});
