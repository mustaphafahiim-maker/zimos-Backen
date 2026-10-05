'use strict';

const db = require('../../db/models');

/**
 * A funnel's shipping group (SPEC §9.7; funnel settings → shippingProfileId):
 * every product of an order placed in the funnel is priced with that group
 * (shipping/shippingProfiles.js), whatever group the product has in the
 * store — a funnel sold to another country, or with its own delivery promise,
 * keeps its own price. The shipping quote and the order agree because both go
 * through calculateShippingAmount with the funnel id.
 */
async function funnelProfileId(workspaceId, funnelId, transaction) {
  if (!funnelId) return null;
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['settings'], transaction });
  const id = funnel && funnel.settings && funnel.settings.shippingProfileId;
  if (!id) return null;
  const profile = await db.ShippingProfile.findOne({ where: { id, workspaceId }, attributes: ['id'], transaction });
  return profile ? profile.id : null;
}

/** The order's product lines with the funnel's group in place of their own, when the funnel has one. */
async function productLinesFor(workspaceId, funnelId, productLines, transaction) {
  const profileId = await funnelProfileId(workspaceId, funnelId, transaction);
  if (!profileId) return productLines;
  return (productLines || []).map((line) => ({ ...(line || {}), profileId }));
}

module.exports = { productLinesFor, funnelProfileId };
