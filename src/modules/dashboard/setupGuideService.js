'use strict';

const db = require('../../db/models');
const paymentMethods = require('../payments/paymentMethodsService');

/**
 * Setup guide (SPEC §18.6): the launch checklist, read from what the store
 * actually has — nothing is ticked by hand, so it cannot drift from reality.
 *
 *   product   an active product exists
 *   website   a website is published
 *   payment   the storefront offers at least one way to pay (COD counts)
 *   shipping  a courier account is connected or a shipping rate is set
 *   domain    a custom domain is verified                      (optional)
 *   pixel     an ad pixel is added                             (optional)
 *   order     the store has received an order
 *
 * The percentage counts the required steps only; optional ones are shown but
 * do not hold a store below 100%.
 */

const exists = async (model, where) => (await model.count({ where })) > 0;

async function setupGuide(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  const settings = (workspace && workspace.settings) || {};
  const legacyPixels = settings.tracking_pixels && typeof settings.tracking_pixels === 'object' ? Object.values(settings.tracking_pixels) : [];

  const [product, website, methods, carrier, rate, domain, pixel, order] = await Promise.all([
    exists(db.Product, { workspaceId, status: 'active' }),
    exists(db.Website, { workspaceId, status: 'published' }),
    paymentMethods.storefrontMethods(workspace).catch(() => []),
    exists(db.CarrierAccount, { workspaceId, status: 'active' }),
    exists(db.ShippingRate, { workspaceId, isActive: true }),
    exists(db.Domain, { workspaceId, status: ['verified', 'active'] }),
    db.TrackingPixel ? exists(db.TrackingPixel, { workspaceId, isActive: true }) : false,
    exists(db.Order, { workspaceId }),
  ]);

  const steps = [
    { key: 'product', done: product, optional: false },
    { key: 'website', done: website, optional: false },
    { key: 'payment', done: Array.isArray(methods) && methods.length > 0, optional: false },
    { key: 'shipping', done: carrier || rate, optional: false },
    { key: 'domain', done: domain, optional: true },
    { key: 'pixel', done: pixel || legacyPixels.some((v) => Boolean(v)), optional: true },
    { key: 'order', done: order, optional: false },
  ];
  const required = steps.filter((s) => !s.optional);
  const completed = required.filter((s) => s.done).length;
  return {
    steps,
    completed,
    total: required.length,
    percent: Math.round((100 * completed) / required.length),
    done: completed === required.length,
  };
}

module.exports = { setupGuide };
