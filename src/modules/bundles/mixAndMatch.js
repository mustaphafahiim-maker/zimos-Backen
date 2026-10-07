'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { NotFoundError } = require('../../core/errors/AppError');
const { effectiveVariantPrice } = require('../catalog/productPage');

/*
 * The box builder of a mix-and-match bundle (spec-gaps item 215): the
 * storefront lists what can go in the box; the shopper adds the pieces to the
 * cart as ordinary lines, and the cart and checkout price them together
 * (bundlePricing.applyBundleTiers groups a mix-and-match bundle's products).
 */

// Mounted at /api/v1/store/:workspaceId/bundles.
const store = Router({ mergeParams: true });
store.get(
  '/:bundleId/products',
  resolvePublicWorkspace,
  validate({ params: Joi.object({ workspaceId: Joi.string().required(), bundleId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const ws = req.publicWorkspace.id;
    const bundle = await db.Bundle.findOne({ where: { id: req.params.bundleId, workspaceId: ws, isActive: true, mixAndMatch: true }, include: [{ model: db.BundleTier, as: 'tiers' }] });
    if (!bundle) throw new NotFoundError('Bundle');
    const products = await db.Product.findAll({
      where: { workspaceId: ws, bundleId: bundle.id, status: 'active' },
      attributes: ['id', 'name', 'slug', 'media', 'pageSettings', 'trackInventory'],
      include: [{ model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: true }],
      order: [['name', 'ASC']],
      limit: 200,
    });
    res.set('Cache-Control', 'public, max-age=120');
    res.json({
      bundle: require('./bundlePricing').presentBundle(bundle, []),
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        imageUrl: (Array.isArray(p.media) && p.media.find((m) => m && m.url) || {}).url || null,
        variants: p.variants.map((v) => ({ id: v.id, optionValues: v.optionValues, priceAmount: String(effectiveVariantPrice(v, p).priceAmount), currency: v.currency, available: !p.trackInventory || v.allowOverselling || v.stockOnHand - v.reservedStock > 0 })),
      })),
    });
  })
);

// The box's price for the shopper's current picks (frontend request, 2026-10-07):
// the same tier pricing the cart and checkout use, so the page shows the price the order will have.
store.post(
  '/:bundleId/quote',
  resolvePublicWorkspace,
  validate({
    params: Joi.object({ workspaceId: Joi.string().required(), bundleId: Joi.string().uuid().required() }),
    body: Joi.object({ picks: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(100).required() })).max(100).required() }),
  }),
  asyncHandler(async (req, res) => {
    const ws = req.publicWorkspace.id;
    const bundle = await db.Bundle.findOne({ where: { id: req.params.bundleId, workspaceId: ws, isActive: true, mixAndMatch: true }, include: [{ model: db.BundleTier, as: 'tiers' }] });
    if (!bundle) throw new NotFoundError('Bundle');
    const ids = req.body.picks.map((p) => p.variantId);
    const variants = new Map((await db.ProductVariant.findAll({ where: { id: ids, workspaceId: ws, status: 'active' }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'bundleId', 'pageSettings', 'status'] }] })).map((v) => [v.id, v]));
    const units = [];
    const ignored = [];
    let currency = null;
    for (const p of req.body.picks) {
      const v = variants.get(p.variantId);
      if (!v || !v.product || v.product.bundleId !== bundle.id || v.product.status !== 'active') { ignored.push(p.variantId); continue; }
      currency = currency || v.currency;
      const price = Number(effectiveVariantPrice(v, v.product).priceAmount);
      for (let i = 0; i < p.quantity; i += 1) units.push(price);
    }
    const priced = require('./bundlePricing').priceUnits(bundle.tiers, units);
    const next = [...bundle.tiers].filter((t) => t.quantity > units.length).sort((a, b) => a.quantity - b.quantity)[0] || null;
    res.json({
      units: units.length,
      currency,
      full: String(priced.full),
      discount: String(priced.discount),
      total: String(priced.total),
      freeShipping: priced.freeShipping,
      tiers: priced.tiers,
      nextTier: next ? { id: next.id, title: next.title, quantity: next.quantity, missingUnits: next.quantity - units.length } : null,
      ignored,
    });
  })
);

module.exports = { store };
