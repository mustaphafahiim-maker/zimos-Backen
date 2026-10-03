'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Product economics (SPEC §15.4): the store's default costs and the products
 * that override them. Unit cost itself stays on the variants (`costAmount`).
 */

const FIELDS = ['packagingCostAmount', 'shippingCostAmount', 'returnCostAmount', 'collectionFeeBp', 'gatewayFeeBp', 'damageBp'];

const num = (v) => (v === null || v === undefined ? null : Number(v));
const serialize = (row) => Object.fromEntries(FIELDS.map((f) => [f, row ? num(row[f]) : null]));
const pick = (body) => Object.fromEntries(FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));

async function list(workspaceId) {
  const [rows, products] = await Promise.all([
    db.ProductEconomics.findAll({ where: { workspaceId } }),
    db.sequelize.query(
      `SELECT p.id, p.name, p.status, min(v.cost_amount) AS min_cost, max(v.cost_amount) AS max_cost,
              min(v.price_amount) AS min_price, max(v.price_amount) AS max_price,
              count(v.id) FILTER (WHERE v.cost_amount IS NULL) AS variants_without_cost, count(v.id) AS variants
         FROM products p
         LEFT JOIN product_variants v ON v.product_id = p.id AND v.workspace_id = p.workspace_id
        WHERE p.workspace_id = :workspaceId AND p.status <> 'archived'
        GROUP BY p.id
        ORDER BY p.name
        LIMIT 500`,
      { replacements: { workspaceId }, type: db.Sequelize.QueryTypes.SELECT }
    ),
  ]);
  const byProduct = new Map(rows.filter((r) => r.productId).map((r) => [r.productId, r]));
  return {
    defaults: serialize(rows.find((r) => !r.productId)),
    products: products.map((p) => ({
      productId: p.id,
      name: p.name,
      status: p.status,
      minCostAmount: num(p.min_cost),
      maxCostAmount: num(p.max_cost),
      minPriceAmount: num(p.min_price),
      maxPriceAmount: num(p.max_price),
      variants: Number(p.variants),
      variantsWithoutCost: Number(p.variants_without_cost),
      overrides: byProduct.has(p.id) ? serialize(byProduct.get(p.id)) : null,
    })),
  };
}

async function upsert(workspaceId, productId, body, req) {
  if (productId) {
    const product = await db.Product.findOne({ where: { id: productId, workspaceId }, attributes: ['id'] });
    if (!product) throw new NotFoundError('Product');
  }
  const patch = pick(body);
  let row = await db.ProductEconomics.findOne({ where: { workspaceId, productId: productId || null } });
  const before = row ? serialize(row) : null;
  if (row) await row.update(patch);
  else row = await db.ProductEconomics.create({ workspaceId, productId: productId || null, ...patch });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: productId ? 'product_economics.update' : 'product_economics.defaults_update',
    entityType: 'ProductEconomics',
    entityId: row.id,
    before,
    after: serialize(row),
    req,
  });
  return serialize(row);
}

async function remove(workspaceId, productId, req) {
  const row = await db.ProductEconomics.findOne({ where: { workspaceId, productId } });
  if (!row) throw new NotFoundError('Product economics');
  const before = serialize(row);
  await row.destroy();
  await recordAudit({
    workspaceId, actorUserId: req.user.id, action: 'product_economics.delete', entityType: 'ProductEconomics', entityId: row.id, before, req,
  });
  return { deleted: true };
}

module.exports = { list, upsert, remove, FIELDS };
