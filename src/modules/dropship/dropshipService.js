'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');
const { recordAudit } = require('../audit/auditService');
const providers = require('./providers');

/**
 * Dropshipping through a provider adapter (providers/README.md): connect an
 * account, import a product as a draft, forward an order, copy stock.
 * The provider only ever answers questions — every write to the store goes
 * through the catalog, inventory and order services the dashboard uses.
 */

const integrationKey = (code) => `dropship:${code}`;

function providerOrThrow(code) {
  const provider = providers.get(code);
  if (!provider) throw new NotFoundError('Dropship provider');
  return provider;
}

/** A provider's own failure as an API error; anything unexpected is "unavailable". */
function asAppError(err) {
  if (err instanceof AppError) return err;
  const known = ['DROPSHIP_INVALID_CREDENTIALS', 'DROPSHIP_PRODUCT_NOT_FOUND', 'DROPSHIP_ORDER_REJECTED', 'DROPSHIP_UNAVAILABLE'];
  if (known.includes(err.code)) return new AppError(err.code, err.message, err.status || 502);
  return new AppError('DROPSHIP_UNAVAILABLE', 'The supplier could not be reached. Try again in a moment.', 502);
}

async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    throw asAppError(err);
  }
}

async function connection(workspaceId, code) {
  // A supplier listed in the app store works only while its app is installed.
  if (require('../apps/appCatalogue').BY_KEY.has(`dropship_${code}`)) await require('../apps/appGate').assertEnabled(workspaceId, `dropship_${code}`);
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (!row || row.status !== 'connected') throw new AppError('DROPSHIP_NOT_CONNECTED', 'Connect this supplier first', 409);
  return { row, credentials: JSON.parse(secretBox.open(row.secretsSealed)) };
}

async function listProviders(workspaceId) {
  const { available, planned } = providers.list();
  const rows = await db.WorkspaceIntegration.findAll({ where: { workspaceId, provider: available.map((p) => integrationKey(p.code)) } });
  const byCode = new Map(rows.map((row) => [row.provider.split(':')[1], row]));
  return {
    providers: available.map((provider) => {
      const row = byCode.get(provider.code);
      return {
        code: provider.code,
        name: provider.name,
        isTest: Boolean(provider.isTest),
        credentialFields: provider.credentialFields,
        connected: Boolean(row && row.status === 'connected'),
        accountName: row ? row.config.accountName || null : null,
        lastVerifiedAt: row ? row.lastVerifiedAt : null,
        // Forwarding by itself and following the status (dropshipOrders.js).
        ...require('./dropshipOrders').settingsOf(row),
        followsStatus: typeof provider.getOrderStatus === 'function',
      };
    }),
    planned,
  };
}

async function connect(workspaceId, code, credentials, req) {
  const provider = providerOrThrow(code);
  const info = await call(() => provider.verifyCredentials(credentials));
  const values = {
    status: 'connected',
    config: { accountName: (info && info.accountName) || null },
    secretsSealed: secretBox.seal(JSON.stringify(credentials)),
    lastVerifiedAt: new Date(),
    lastError: null,
  };
  const [row, created] = await db.WorkspaceIntegration.findOrCreate({
    where: { workspaceId, provider: integrationKey(code) },
    defaults: { workspaceId, provider: integrationKey(code), ...values },
  });
  if (!created) await row.update(values);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'dropship.connect', entityType: 'WorkspaceIntegration', entityId: row.id, after: { provider: code }, req });
  return { code, connected: true, accountName: values.config.accountName };
}

async function disconnect(workspaceId, code, req) {
  providerOrThrow(code);
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (row) {
    await row.destroy();
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'dropship.disconnect', entityType: 'WorkspaceIntegration', entityId: row.id, before: { provider: code }, req });
  }
  return { code, connected: false };
}

/** Imports one product as a draft: the merchant reviews price and text before it goes live. */
async function importProduct(workspaceId, code, productCode, req) {
  const provider = providerOrThrow(code);
  const { credentials } = await connection(workspaceId, code);
  const source = await call(() => provider.importProduct(credentials, productCode));

  const already = await db.Product.findOne({
    where: db.sequelize.literal(
      `"Product"."workspace_id" = ${db.sequelize.escape(workspaceId)} AND "Product"."external_refs" @> ${db.sequelize.escape(JSON.stringify([{ platform: code, code: source.externalId }]))}::jsonb`
    ),
    attributes: ['id'],
  });
  if (already) throw new AppError('DROPSHIP_ALREADY_IMPORTED', 'This product was already imported', 409, { productId: already.id });

  // eslint-disable-next-line global-require
  const catalogService = require('../catalog/catalogService');
  const [first, ...rest] = source.variants;
  const variantOf = (v) => ({ sku: v.code, priceAmount: v.priceAmount, costAmount: v.costAmount ?? null, optionValues: v.options || {}, stockOnHand: v.stock || 0 });
  const { product } = await catalogService.createProduct(
    workspaceId,
    { name: source.name, description: source.description || '', status: 'draft', externalRefs: [{ platform: code, code: source.externalId }], variant: variantOf(first) },
    req
  );
  // createVariant leaves stock at zero by design: it goes in through inventory.
  // eslint-disable-next-line global-require
  const inventoryService = require('../inventory/inventoryService');
  for (const variant of rest) {
    const created = await catalogService.createVariant(workspaceId, product.id, variantOf(variant), req);
    if (variant.stock > 0) {
      await inventoryService.adjustStock({ workspaceId, variantId: created.id, delta: variant.stock, reason: `Imported from ${provider.name}`, actorUserId: req.user.id });
    }
  }
  return { product: await catalogService.getProduct(workspaceId, product.id) };
}

/**
 * Forwards an order to the provider. Pushing again returns the same reference.
 * `req` is null when it forwards by itself (dropshipOrders.autoForward, via "auto").
 */
const PUSH_STALE_MS = 2 * 60 * 1000;

async function pushOrder(workspaceId, code, orderId, req, { via = 'manual' } = {}) {
  const provider = providerOrThrow(code);
  const { credentials } = await connection(workspaceId, code);
  // eslint-disable-next-line global-require
  const full = require('../publicApi/publicOrderSerializer').serializeOrder(await require('../orders/orderService').getOrder(workspaceId, orderId));
  // A mixed order sends this supplier only its own lines.
  const order = await require('./dropshipOrders').linesFor(workspaceId, code, full);
  const answer = (ref) => ({ orderId, provider: code, externalOrderId: ref.externalOrderId, externalStatus: ref.externalStatus, suggestedStage: provider.mapStatus(ref.externalStatus) });
  // One remote order per order and supplier (items 307, 318): the reference is claimed first, in a short
  // transaction under a lock, and the supplier is called with no transaction open. A double click, or a
  // manual push racing the automatic one, finds the claim: 409 while it is being sent, the reference after.
  // A claim left by a crash is taken over after PUSH_STALE_MS.
  const { PUSH_PENDING } = require('./dropshipOrders');
  const claim = await db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `dropship-push:${workspaceId}:${orderId}:${code}` }, transaction });
    const existing = await db.DropshipOrderRef.findOne({ where: { workspaceId, orderId, provider: code }, transaction });
    if (existing && existing.externalOrderId !== PUSH_PENDING) return { done: existing };
    if (existing && Date.now() - new Date(existing.pushedAt).getTime() < PUSH_STALE_MS) {
      throw new AppError('DROPSHIP_PUSH_IN_PROGRESS', 'This order is being sent to the supplier — check again in a moment', 409);
    }
    if (existing) return { mine: await existing.update({ pushedAt: new Date(), forwardedBy: via, lastError: null }, { transaction }) };
    return { mine: await db.DropshipOrderRef.create({ workspaceId, orderId, provider: code, externalOrderId: PUSH_PENDING, externalStatus: null, forwardedBy: via }, { transaction }) };
  });
  if (claim.done) return answer(claim.done);
  let result;
  try {
    result = await call(() => provider.pushOrder(credentials, order));
  } catch (e) {
    // Not sent: the claim goes, so the order can be sent again.
    await db.DropshipOrderRef.destroy({ where: { id: claim.mine.id, externalOrderId: PUSH_PENDING } }).catch(() => {});
    throw e;
  }
  const ref = await claim.mine.update({ externalOrderId: result.externalOrderId, externalStatus: result.externalStatus || null, pushedAt: new Date() });
  await recordAudit({ workspaceId, actorUserId: req && req.user ? req.user.id : null, action: 'dropship.push_order', entityType: 'Order', entityId: orderId, after: { provider: code, externalOrderId: ref.externalOrderId }, metadata: { via }, req });
  return answer(ref);
}

/** Sets each imported variant's stock to what the provider has now. */
async function syncStock(workspaceId, code, req) {
  const provider = providerOrThrow(code);
  const { credentials } = await connection(workspaceId, code);
  const products = await db.Product.findAll({
    where: db.sequelize.literal(
      `"Product"."workspace_id" = ${db.sequelize.escape(workspaceId)} AND "Product"."external_refs" @> ${db.sequelize.escape(JSON.stringify([{ platform: code }]))}::jsonb`
    ),
    attributes: ['id', 'externalRefs'],
  });
  const externalIds = products.flatMap((p) => (p.externalRefs || []).filter((r) => r.platform === code).map((r) => r.code));
  if (externalIds.length === 0) return { products: 0, updated: 0 };
  const stock = await call(() => provider.syncStock(credentials, externalIds));
  // eslint-disable-next-line global-require
  const inventoryService = require('../inventory/inventoryService');
  let updated = 0;
  for (const line of stock) {
    const variant = await db.ProductVariant.findOne({ where: { workspaceId, sku: line.code, productId: products.map((p) => p.id) } });
    if (!variant || variant.stockOnHand === line.stock) continue;
    // Never below what is already promised to orders.
    const target = Math.max(line.stock, variant.reservedStock);
    if (target === variant.stockOnHand) continue;
    await inventoryService.adjustStock({ workspaceId, variantId: variant.id, delta: target - variant.stockOnHand, reason: `Stock sync: ${provider.name}`, actorUserId: req.user.id });
    updated += 1;
  }
  return { products: products.length, updated };
}

module.exports = { listProviders, connect, disconnect, importProduct, pushOrder, syncStock };
