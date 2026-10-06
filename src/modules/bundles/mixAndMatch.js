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

module.exports = { store };
