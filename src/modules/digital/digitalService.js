'use strict';

const crypto = require('crypto');
const path = require('path');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const outbox = require('../../core/outbox/outbox');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getStorage } = require('../media/storage');

/**
 * Digital products (SPEC §18.2).
 *
 * A digital product has one delivery: a file from the file library, a link,
 * or a licence code drawn from stock. When an order is paid — never before,
 * so a COD order delivers only once the money is recorded — every digital
 * line gets a grant: a snapshot of what was sold plus the token of the
 * buyer's download link. The file itself never has a public address; it is
 * streamed through the API after the token, the expiry and the download
 * limit are checked.
 */

// One request holds the file in memory, so the cap is modest. Larger files
// (the spec's multipart upload straight to storage) are the storage
// integration's job; `link` delivery covers them until then.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const TYPES = ['file', 'link', 'license_codes'];

const { Op } = db.Sequelize;

// ------------------------------------------------------------ file library --

function fileView(f, usedBy) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    sizeBytes: Number(f.sizeBytes),
    createdAt: f.createdAt,
    ...(usedBy !== undefined ? { usedByProducts: usedBy } : {}),
  };
}

async function listFiles(workspaceId) {
  const [files, deliveries] = await Promise.all([
    db.DigitalFile.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']], limit: 500 }),
    db.DigitalDelivery.findAll({ where: { workspaceId, fileId: { [Op.ne]: null } }, attributes: ['fileId'], raw: true }),
  ]);
  const used = new Map();
  for (const d of deliveries) used.set(d.fileId, (used.get(d.fileId) || 0) + 1);
  return { files: files.map((f) => fileView(f, used.get(f.id) || 0)), maxFileBytes: MAX_FILE_BYTES };
}

async function uploadFile(workspaceId, file, req) {
  if (!file || !file.buffer || file.buffer.length === 0) throw new AppError('FILE_REQUIRED', 'Choose a file to upload', 422);
  // multer reads the multipart filename as latin1; Arabic names arrive as UTF-8 bytes.
  const original = Buffer.from(file.originalname || 'file', 'latin1').toString('utf8');
  const name = path.basename(original).replace(/[\u0000-\u001f]/g, '').slice(0, 300) || 'file';
  const id = crypto.randomUUID();
  const storageKey = `digital/${workspaceId}/${id}`;
  const mimeType = (file.mimetype || 'application/octet-stream').slice(0, 150);

  await getStorage().putPrivate({ key: storageKey, buffer: file.buffer, contentType: mimeType });
  const row = await db.DigitalFile.create({
    id,
    workspaceId,
    name,
    storageKey,
    mimeType,
    sizeBytes: file.buffer.length,
    uploadedByUserId: req.user.id,
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'digital_file.upload',
    entityType: 'DigitalFile',
    entityId: row.id,
    after: { name, sizeBytes: file.buffer.length },
    req,
  });
  return fileView(row, 0);
}

async function deleteFile(workspaceId, fileId, req) {
  const file = await scoped(db.DigitalFile, workspaceId, 'File').findByPkOrThrow(fileId);
  const inUse = await db.DigitalDelivery.count({ where: { workspaceId, fileId } });
  if (inUse > 0) {
    throw new AppError('FILE_IN_USE', 'A product still delivers this file. Change its delivery first.', 409, { products: inUse });
  }
  await file.destroy();
  await getStorage()
    .removePrivate(file.storageKey)
    .catch((err) => logger.error(`[digital] could not remove ${file.storageKey}: ${err.message}`));
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'digital_file.delete',
    entityType: 'DigitalFile',
    entityId: fileId,
    before: { name: file.name },
    req,
  });
}

// --------------------------------------------------------------- deliveries --

function deliveryView(d) {
  if (!d) return null;
  return {
    id: d.id,
    productId: d.productId,
    type: d.type,
    fileId: d.fileId,
    file: d.file ? fileView(d.file) : null,
    linkUrl: d.linkUrl,
    message: d.message,
    maxDownloads: d.maxDownloads,
    linkValidHours: d.linkValidHours,
    isActive: d.isActive,
    updatedAt: d.updatedAt,
  };
}

async function codeStock(workspaceId, productIds) {
  if (productIds.length === 0) return new Map();
  const rows = await db.LicenseCode.findAll({
    where: { workspaceId, productId: productIds },
    attributes: [
      'productId',
      [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'total'],
      [db.sequelize.literal('COUNT(*) FILTER (WHERE assigned_at IS NULL)'), 'available'],
    ],
    group: ['productId'],
    raw: true,
  });
  return new Map(rows.map((r) => [r.productId, { total: Number(r.total), available: Number(r.available) }]));
}

/** Every digital product of the store with its delivery and code stock. */
async function listProducts(workspaceId) {
  const products = await db.Product.findAll({
    where: { workspaceId, productType: 'digital', status: { [Op.ne]: 'archived' } },
    attributes: ['id', 'name', 'status', 'productCode', 'media'],
    order: [['createdAt', 'DESC']],
  });
  const ids = products.map((p) => p.id);
  const [deliveries, stock] = await Promise.all([
    ids.length
      ? db.DigitalDelivery.findAll({ where: { workspaceId, productId: ids }, include: [{ model: db.DigitalFile, as: 'file' }] })
      : [],
    codeStock(workspaceId, ids),
  ]);
  const byProduct = new Map(deliveries.map((d) => [d.productId, d]));
  return {
    products: products.map((p) => {
      const first = Array.isArray(p.media) ? p.media[0] : null;
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        productCode: p.productCode,
        imageUrl: (first && (first.url || first.src)) || null,
        delivery: deliveryView(byProduct.get(p.id)),
        codes: stock.get(p.id) || { total: 0, available: 0 },
      };
    }),
  };
}

async function digitalProduct(workspaceId, productId, transaction) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId }, transaction });
  if (!product) throw new NotFoundError('Product');
  if (product.productType !== 'digital') {
    throw new AppError('PRODUCT_NOT_DIGITAL', 'Only a digital product has a delivery. Change the product type first.', 422);
  }
  return product;
}

async function getDelivery(workspaceId, productId) {
  await digitalProduct(workspaceId, productId);
  const delivery = await db.DigitalDelivery.findOne({ where: { workspaceId, productId }, include: [{ model: db.DigitalFile, as: 'file' }] });
  const stock = await codeStock(workspaceId, [productId]);
  return { delivery: deliveryView(delivery), codes: stock.get(productId) || { total: 0, available: 0 } };
}

async function saveDelivery(workspaceId, productId, data, req) {
  await digitalProduct(workspaceId, productId);
  const values = {
    type: data.type,
    fileId: data.type === 'file' ? data.fileId : null,
    linkUrl: data.type === 'link' ? data.linkUrl : null,
    message: data.message || null,
    maxDownloads: data.type === 'file' ? data.maxDownloads || null : null,
    linkValidHours: data.linkValidHours || null,
    isActive: data.isActive !== false,
  };
  if (values.type === 'file') {
    if (!values.fileId) throw new AppError('VALIDATION_ERROR', 'Choose the file to deliver', 422, [{ field: 'fileId', message: 'required' }]);
    await scoped(db.DigitalFile, workspaceId, 'File').findByPkOrThrow(values.fileId);
  }

  const existing = await db.DigitalDelivery.findOne({ where: { workspaceId, productId } });
  const before = deliveryView(existing);
  const saved = existing ? await existing.update(values) : await db.DigitalDelivery.create({ ...values, workspaceId, productId });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: existing ? 'digital_delivery.update' : 'digital_delivery.create',
    entityType: 'DigitalDelivery',
    entityId: saved.id,
    before,
    after: deliveryView(saved),
    req,
  });
  return getDelivery(workspaceId, productId);
}

// ------------------------------------------------------------ licence codes --

async function listCodes(workspaceId, productId, { status, limit = 100 } = {}) {
  await digitalProduct(workspaceId, productId);
  const where = { workspaceId, productId };
  if (status === 'available') where.assignedAt = null;
  if (status === 'assigned') where.assignedAt = { [Op.ne]: null };
  const [rows, stock] = await Promise.all([
    db.LicenseCode.findAll({ where, order: [['createdAt', 'DESC']], limit }),
    codeStock(workspaceId, [productId]),
  ]);
  return {
    codes: rows.map((c) => ({ id: c.id, code: c.code, assignedAt: c.assignedAt, grantId: c.grantId, createdAt: c.createdAt })),
    ...(stock.get(productId) || { total: 0, available: 0 }),
  };
}

/** Adds codes from pasted text, one per line. Duplicates are skipped, not errors. */
async function addCodes(workspaceId, productId, text, req) {
  await digitalProduct(workspaceId, productId);
  const wanted = [...new Set(String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  const tooLong = wanted.filter((c) => c.length > 200).length;
  const codes = wanted.filter((c) => c.length <= 200);
  const existing = codes.length
    ? await db.LicenseCode.findAll({ where: { productId, code: codes }, attributes: ['code'], raw: true })
    : [];
  const known = new Set(existing.map((r) => r.code));
  const fresh = codes.filter((c) => !known.has(c));
  await db.LicenseCode.bulkCreate(
    fresh.map((code) => ({ workspaceId, productId, code })),
    { ignoreDuplicates: true }
  );
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'license_codes.add',
    entityType: 'Product',
    entityId: productId,
    metadata: { added: fresh.length, duplicates: codes.length - fresh.length },
    req,
  });
  // Orders that were paid while the stock was empty get their codes now.
  await fillMissingCodes(workspaceId, productId);
  return { added: fresh.length, duplicates: codes.length - fresh.length, tooLong };
}

async function deleteCode(workspaceId, codeId, req) {
  const code = await scoped(db.LicenseCode, workspaceId, 'Code').findByPkOrThrow(codeId);
  if (code.assignedAt) throw new AppError('CODE_ASSIGNED', 'This code was already given to a customer', 409);
  await code.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'license_codes.delete',
    entityType: 'LicenseCode',
    entityId: codeId,
    metadata: { productId: code.productId },
    req,
  });
}

/** Takes up to `count` unassigned codes for a grant, oldest first, without racing another order. */
async function drawCodes(productId, grantId, count, transaction) {
  if (count <= 0) return [];
  const rows = await db.sequelize.query(
    `UPDATE license_codes SET grant_id = :grantId, assigned_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM license_codes
         WHERE product_id = :productId AND assigned_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT :count
         FOR UPDATE SKIP LOCKED)
      RETURNING code`,
    { replacements: { productId, grantId, count }, type: db.Sequelize.QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => r.code);
}

async function fillMissingCodes(workspaceId, productId) {
  const waiting = await db.DigitalGrant.findAll({
    where: { workspaceId, productId, type: 'license_codes', codesMissing: { [Op.gt]: 0 }, revokedAt: null },
    order: [['createdAt', 'ASC']],
  });
  for (const grant of waiting) {
    await db.sequelize.transaction(async (transaction) => {
      const drawn = await drawCodes(productId, grant.id, grant.codesMissing, transaction);
      if (drawn.length === 0) return;
      await grant.update({ codes: [...grant.codes, ...drawn], codesMissing: grant.codesMissing - drawn.length }, { transaction });
    });
  }
}

// ------------------------------------------------------------------ grants --

const newToken = () => crypto.randomBytes(32).toString('hex');

function grantState(grant, now = new Date()) {
  if (grant.revokedAt) return 'revoked';
  if (grant.expiresAt && new Date(grant.expiresAt) <= now) return 'expired';
  if (grant.type === 'file' && grant.maxDownloads !== null && grant.downloadCount >= grant.maxDownloads) return 'used_up';
  return 'active';
}

function grantView(grant) {
  return {
    id: grant.id,
    orderId: grant.orderId,
    orderItemId: grant.orderItemId,
    productId: grant.productId,
    productName: grant.productName,
    type: grant.type,
    fileName: grant.file ? grant.file.name : null,
    linkUrl: grant.linkUrl,
    codes: grant.codes,
    codesMissing: grant.codesMissing,
    token: grant.token,
    maxDownloads: grant.maxDownloads,
    downloadCount: grant.downloadCount,
    lastDownloadedAt: grant.lastDownloadedAt,
    expiresAt: grant.expiresAt,
    state: grantState(grant),
    createdAt: grant.createdAt,
  };
}

/**
 * Called when an order becomes paid, inside that transaction. Creates a grant
 * for each digital line that has an active delivery (once: a line already
 * granted is left alone), and marks an all-digital order fulfilled.
 *
 * Never throws: a delivery problem must not undo a recorded payment.
 */
async function onOrderPaid(workspaceId, orderId, outer) {
  try {
    // A savepoint: a failed statement here must not poison the payment's transaction.
    return await db.sequelize.transaction(outer ? { transaction: outer } : {}, async (transaction) => {
    const items = await db.OrderItem.findAll({ where: { orderId }, transaction });
    const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
    if (productIds.length === 0) return [];
    const products = await db.Product.findAll({
      where: { workspaceId, id: productIds },
      attributes: ['id', 'productType'],
      transaction,
    });
    const digitalIds = products.filter((p) => p.productType === 'digital').map((p) => p.id);
    if (digitalIds.length === 0) return [];

    const [deliveries, already] = await Promise.all([
      db.DigitalDelivery.findAll({ where: { workspaceId, productId: digitalIds, isActive: true }, transaction }),
      db.DigitalGrant.findAll({ where: { workspaceId, orderId }, attributes: ['orderItemId'], transaction, raw: true }),
    ]);
    const deliveryOf = new Map(deliveries.map((d) => [d.productId, d]));
    const granted = new Set(already.map((g) => g.orderItemId));

    const created = [];
    for (const item of items) {
      const delivery = deliveryOf.get(item.productId);
      if (!delivery || granted.has(item.id)) continue;
      const grant = await db.DigitalGrant.create(
        {
          workspaceId,
          orderId,
          orderItemId: item.id,
          productId: item.productId,
          productName: item.productNameSnapshot,
          type: delivery.type,
          fileId: delivery.fileId,
          linkUrl: delivery.linkUrl,
          message: delivery.message,
          codesMissing: delivery.type === 'license_codes' ? item.quantity : 0,
          token: newToken(),
          maxDownloads: delivery.maxDownloads,
          expiresAt: delivery.linkValidHours ? new Date(Date.now() + delivery.linkValidHours * 3600 * 1000) : null,
        },
        { transaction }
      );
      // One code per unit bought. The codes point at the grant, so it exists first.
      if (delivery.type === 'license_codes') {
        const codes = await drawCodes(item.productId, grant.id, item.quantity, transaction);
        if (codes.length) await grant.update({ codes, codesMissing: item.quantity - codes.length }, { transaction });
      }
      created.push(grant);
    }

    if (created.length > 0) {
      const allDigital = items.every((i) => digitalIds.includes(i.productId));
      if (allDigital) {
        // Nothing to ship: the order is complete the moment it is paid.
        await db.Order.update(
          { fulfillmentState: 'fulfilled' },
          { where: { id: orderId, workspaceId, fulfillmentState: 'unfulfilled' }, transaction }
        );
      }
      await outbox.record(
        transaction,
        'order.digital_delivered',
        { workspaceId, orderId, grantIds: created.map((g) => g.id) },
        { aggregateType: 'order', aggregateId: orderId }
      );
    }
    return created;
    });
  } catch (err) {
    logger.error(`[digital] delivery for order ${orderId} failed: ${err.message}`);
    return [];
  }
}

async function listOrderGrants(workspaceId, orderId) {
  const grants = await db.DigitalGrant.findAll({
    where: { workspaceId, orderId },
    include: [{ model: db.DigitalFile, as: 'file' }],
    order: [['createdAt', 'ASC']],
  });
  // Digital lines with a delivery set up that have no grant yet ("Deliver now").
  const [[row]] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS pending
       FROM order_items oi
       JOIN digital_deliveries d ON d.product_id = oi.product_id AND d.is_active
      WHERE oi.order_id = :orderId AND d.workspace_id = :workspaceId
        AND NOT EXISTS (SELECT 1 FROM digital_grants g WHERE g.order_item_id = oi.id)`,
    { replacements: { orderId, workspaceId } }
  );
  return { grants: grants.map(grantView), pending: row.pending };
}

/** Staff: deliver now (an order paid before the delivery was set up), without waiting for a payment event. */
async function deliverOrder(workspaceId, orderId, req) {
  const order = await scoped(db.Order, workspaceId, 'Order').findByPkOrThrow(orderId);
  if (!['paid', 'partially_refunded'].includes(order.financialState)) {
    throw new AppError('ORDER_NOT_PAID', 'Digital products are delivered once the order is paid', 409);
  }
  const created = await db.sequelize.transaction((transaction) => onOrderPaid(workspaceId, orderId, transaction));
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'digital_grant.deliver',
    entityType: 'Order',
    entityId: orderId,
    metadata: { grants: created.length },
    req,
  });
  return listOrderGrants(workspaceId, orderId);
}

/** Staff: give the buyer a fresh start — downloads back to zero, a new expiry, or cut the link off. */
async function updateGrant(workspaceId, grantId, { action }, req) {
  const grant = await scoped(db.DigitalGrant, workspaceId, 'Grant').findByPkOrThrow(grantId);
  const before = { downloadCount: grant.downloadCount, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt };
  if (action === 'revoke') await grant.update({ revokedAt: new Date() });
  if (action === 'renew') {
    const delivery = grant.productId ? await db.DigitalDelivery.findOne({ where: { workspaceId, productId: grant.productId } }) : null;
    const hours = delivery ? delivery.linkValidHours : null;
    await grant.update({ downloadCount: 0, revokedAt: null, expiresAt: hours ? new Date(Date.now() + hours * 3600 * 1000) : null });
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: `digital_grant.${action}`,
    entityType: 'DigitalGrant',
    entityId: grant.id,
    before,
    after: { downloadCount: grant.downloadCount, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt },
    req,
  });
  const fresh = await db.DigitalGrant.findByPk(grant.id, { include: [{ model: db.DigitalFile, as: 'file' }] });
  return grantView(fresh);
}

// ------------------------------------------------------------------ public --

function publicView(grant) {
  const state = grantState(grant);
  const open = state === 'active';
  return {
    productName: grant.productName,
    type: grant.type,
    state,
    message: grant.message,
    // What the buyer paid for is shown only while the grant is live.
    fileName: open && grant.file ? grant.file.name : null,
    fileSizeBytes: open && grant.file ? Number(grant.file.sizeBytes) : null,
    linkUrl: open ? grant.linkUrl : null,
    codes: open ? grant.codes : [],
    codesPending: grant.codesMissing,
    downloadsLeft: grant.type === 'file' && grant.maxDownloads !== null ? Math.max(0, grant.maxDownloads - grant.downloadCount) : null,
    expiresAt: grant.expiresAt,
  };
}

async function findByToken(workspaceId, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new NotFoundError('Download');
  const grant = await db.DigitalGrant.findOne({ where: { workspaceId, token }, include: [{ model: db.DigitalFile, as: 'file' }] });
  if (!grant) throw new NotFoundError('Download');
  return grant;
}

async function getPublicGrant(workspaceId, token) {
  return { download: publicView(await findByToken(workspaceId, token)) };
}

/** The file's bytes for a live grant. Counting the download and checking the limit are one statement. */
async function downloadFile(workspaceId, token) {
  const grant = await findByToken(workspaceId, token);
  if (grant.type !== 'file' || !grant.file) throw new NotFoundError('Download');
  const state = grantState(grant);
  if (state !== 'active') throw new AppError('DOWNLOAD_UNAVAILABLE', 'This download link is no longer available', 410, { state });

  const [, taken] = await db.DigitalGrant.update(
    { downloadCount: db.sequelize.literal('download_count + 1'), lastDownloadedAt: new Date() },
    {
      where: {
        id: grant.id,
        revokedAt: null,
        [Op.and]: db.sequelize.literal('(max_downloads IS NULL OR download_count < max_downloads)'),
      },
      returning: true,
    }
  );
  if (!taken || taken.length === 0) {
    throw new AppError('DOWNLOAD_UNAVAILABLE', 'This download link is no longer available', 410, { state: 'used_up' });
  }

  const stored = await getStorage().getPrivate(grant.file.storageKey);
  if (!stored) throw new NotFoundError('Download');
  return { buffer: stored.buffer, name: grant.file.name, mimeType: grant.file.mimeType };
}

/** The live grants of an order, for the customer's tracking page. */
async function publicGrantsForOrder(workspaceId, orderId) {
  const grants = await db.DigitalGrant.findAll({
    where: { workspaceId, orderId, revokedAt: null },
    attributes: ['token', 'productName', 'type'],
    order: [['createdAt', 'ASC']],
  });
  return grants.map((g) => ({ token: g.token, productName: g.productName, type: g.type }));
}

module.exports = {
  TYPES,
  MAX_FILE_BYTES,
  listFiles,
  uploadFile,
  deleteFile,
  listProducts,
  getDelivery,
  saveDelivery,
  listCodes,
  addCodes,
  deleteCode,
  onOrderPaid,
  listOrderGrants,
  deliverOrder,
  updateGrant,
  getPublicGrant,
  downloadFile,
  publicGrantsForOrder,
};
