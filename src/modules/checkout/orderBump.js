'use strict';

const Joi = require('joi');
const db = require('../../db/models');
const { AppError, ValidationError } = require('../../core/errors/AppError');

/**
 * The order bump: one offer the merchant picks, shown as an "add to your
 * order" tick box right above the order button. Ticking it adds that offer as
 * one more line of the same order — priced, shipped, taxed, discounted and
 * reserved with the rest of it by orderService.createOrder — marked
 * order_items.is_order_bump.
 *
 * Where the choice lives:
 *   - the store's own checkout (product page and /checkout):
 *     workspaces.settings.order_bump = { enabled, offer_id, title, description }
 *     (snake_case like every other settings key), written whole through
 *     PATCH /workspaces/:id;
 *   - a funnel step with an order form — its checkout step, or a sales page
 *     whose cod_form takes the order there (SPEC §9.5, §10.3):
 *     funnel_steps.bump_offer_id, frozen into the published snapshot as
 *     `bumpOfferId` like the step's other fields.
 *
 * The browser only says which offer the shopper ticked (`orderBump.offerId`
 * on POST /store/:id/checkout). The server accepts it only when it is the
 * offer configured for that checkout, and builds the line itself from that
 * offer: nothing about its price or contents comes from the client.
 *
 * An offer can be a bump only if it sells at a set price, has lines, belongs
 * to an active product and that product asks the shopper nothing (a tick box
 * has no room for custom fields).
 */

const SETTINGS_KEY = 'order_bump';
// The funnel steps that can hold an order form, and so a bump on it.
const BUMP_STEP_TYPES = Object.freeze(['checkout', 'sales']);
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 240;

/** The PATCH shape of settings.order_bump; sent whole, `null` removes it. */
const orderBumpSettingsSchema = Joi.object({
  enabled: Joi.boolean().required(),
  // Required while on; kept while off, so switching back on needs no re-pick.
  offer_id: Joi.string()
    .uuid()
    .allow(null)
    .when('enabled', { is: true, then: Joi.invalid(null) })
    .required(),
  title: Joi.string().trim().max(TITLE_MAX).allow('', null).optional(),
  description: Joi.string().trim().max(DESCRIPTION_MAX).allow('', null).optional(),
});

/** The store's bump as stored, or null when it is off or malformed. */
function readStoreBump(settings) {
  const stored = settings && typeof settings === 'object' ? settings[SETTINGS_KEY] : null;
  if (!stored || typeof stored !== 'object') return null;
  const { value, error } = orderBumpSettingsSchema.validate(stored, { stripUnknown: true });
  if (error || !value.enabled || !value.offer_id) return null;
  return {
    offerId: value.offer_id,
    title: value.title || null,
    description: value.description || null,
  };
}

/** The offer with everything the checks and the storefront card need. */
async function loadBumpOffer(workspaceId, offerId, transaction) {
  return db.Offer.findOne({
    where: { id: offerId, workspaceId },
    include: [
      { model: db.Product, as: 'product', attributes: ['id', 'name', 'slug', 'status', 'media', 'customFields'] },
      {
        model: db.OfferVariant,
        as: 'lines',
        include: [
          {
            model: db.ProductVariant,
            as: 'variant',
            attributes: [
              'id',
              'status',
              'priceAmount',
              'compareAtAmount',
              'stockOnHand',
              'reservedStock',
              'allowOverselling',
            ],
          },
        ],
      },
    ],
    order: [
      [{ model: db.OfferVariant, as: 'lines' }, 'createdAt', 'ASC'],
      [{ model: db.OfferVariant, as: 'lines' }, 'id', 'ASC'],
    ],
    ...(transaction ? { transaction } : {}),
  });
}

/**
 * Why this offer cannot be a bump, or null when it can:
 * 'not_found' | 'inactive' | 'no_price' | 'no_lines' | 'custom_fields'.
 */
function bumpProblem(offer) {
  if (!offer) return 'not_found';
  if (offer.status !== 'active' || !offer.product || offer.product.status !== 'active') return 'inactive';
  if (offer.priceAmount === null || offer.priceAmount === undefined) return 'no_price';
  const lines = offer.lines || [];
  if (lines.length === 0 || lines.some((l) => !l.variant || l.variant.status !== 'active')) return 'no_lines';
  if (Array.isArray(offer.product.customFields) && offer.product.customFields.length > 0) return 'custom_fields';
  return null;
}

const PROBLEM_MESSAGES = {
  not_found: 'Offer not found in this workspace',
  inactive: 'This offer or its product is not active',
  no_price: 'Only an offer with a set price can be an order bump',
  no_lines: 'This offer has no active variants',
  custom_fields: 'A product that asks the shopper for custom details cannot be an order bump',
};

/** For the settings PATCH and the funnel step: refuses an offer that cannot be a bump (422). */
async function assertBumpOfferUsable(workspaceId, offerId, field) {
  const problem = bumpProblem(await loadBumpOffer(workspaceId, offerId));
  if (problem) {
    throw new ValidationError([{ field, message: PROBLEM_MESSAGES[problem], code: `BUMP_OFFER_${problem.toUpperCase()}` }]);
  }
}

function inStock(offer) {
  return (offer.lines || []).every(
    (l) => l.variant.allowOverselling || Number(l.variant.stockOnHand) - Number(l.variant.reservedStock) >= l.quantity
  );
}

function firstImageUrl(media) {
  const first = Array.isArray(media) ? media.find((m) => m && typeof m.url === 'string' && m.url) : null;
  return first ? first.url : null;
}

/**
 * The card the storefront shows, or null when there is nothing to show (no
 * bump, an offer that can no longer be one, or out of stock). The anchor
 * variant is the offer's first line — the one the order line is filed under.
 */
async function presentBump(workspaceId, offerId, { title = null, description = null } = {}) {
  if (!offerId) return null;
  const offer = await loadBumpOffer(workspaceId, offerId);
  if (bumpProblem(offer) || !inStock(offer)) return null;
  // What the offer's contents cost one by one, shown struck through when the
  // offer is cheaper.
  const regular = offer.lines.reduce(
    (sum, l) => sum + Number(l.variant.compareAtAmount || l.variant.priceAmount || 0) * l.quantity,
    0
  );
  const price = Number(offer.priceAmount);
  return {
    offerId: offer.id,
    variantId: offer.lines[0].variantId,
    productId: offer.product.id,
    productSlug: offer.product.slug,
    title: title || null,
    name: offer.name,
    productName: offer.product.name,
    description: description || null,
    imageUrl: firstImageUrl(offer.product.media),
    priceAmount: price,
    compareAtAmount: regular > price ? regular : null,
    currency: offer.currency,
    lines: offer.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  };
}

/** GET /store/:id → store.orderBump. */
async function presentStoreBump(workspace) {
  const bump = readStoreBump(workspace.settings);
  if (!bump) return null;
  return presentBump(workspace.id, bump.offerId, bump);
}

/**
 * The bump offer ids a checkout may carry: the funnel's checkout steps' bumps
 * (from its published snapshot) for a funnel order, the store's bump otherwise.
 */
async function allowedBumpOfferIds(workspace, funnelId) {
  if (!funnelId) {
    const bump = readStoreBump(workspace.settings);
    return bump ? [bump.offerId] : [];
  }
  const funnel = await db.Funnel.findOne({
    where: { id: funnelId, workspaceId: workspace.id, status: 'published' },
    attributes: ['id', 'publishedRevisionId'],
  });
  if (!funnel || !funnel.publishedRevisionId) return [];
  const revision = await db.FunnelRevision.findOne({
    where: { id: funnel.publishedRevisionId, funnelId: funnel.id },
    attributes: ['snapshot'],
  });
  const steps = (revision && revision.snapshot && revision.snapshot.steps) || [];
  return steps.filter((s) => BUMP_STEP_TYPES.includes(s.stepType) && s.bumpOfferId).map((s) => s.bumpOfferId);
}

/**
 * The order line for a ticked bump. Refuses an offer that is not the one
 * configured for this checkout (422 ORDER_BUMP_INVALID — a forged or stale
 * request) and one that can no longer be sold (409 ORDER_BUMP_UNAVAILABLE —
 * the storefront unticks it and says so). Stock is checked for real when the
 * order reserves it, in the order's own transaction.
 */
async function resolveOrderBumpItem(workspace, { offerId, funnelId }) {
  const allowed = await allowedBumpOfferIds(workspace, funnelId);
  if (!allowed.includes(offerId)) {
    throw new AppError('ORDER_BUMP_INVALID', 'This add-on is not offered with this order', 422, [
      { field: 'orderBump.offerId', message: 'Not the order bump this checkout offers' },
    ]);
  }
  const offer = await loadBumpOffer(workspace.id, offerId);
  if (bumpProblem(offer)) throw orderBumpUnavailable();
  return { variantId: offer.lines[0].variantId, offerId: offer.id, quantity: 1, isOrderBump: true };
}

function orderBumpUnavailable() {
  return new AppError('ORDER_BUMP_UNAVAILABLE', 'The add-on is no longer available', 409, [
    { field: 'orderBump.offerId', message: 'The add-on is no longer available' },
  ]);
}

module.exports = {
  SETTINGS_KEY,
  BUMP_STEP_TYPES,
  orderBumpSettingsSchema,
  readStoreBump,
  bumpProblem,
  assertBumpOfferUsable,
  presentBump,
  presentStoreBump,
  resolveOrderBumpItem,
  orderBumpUnavailable,
};
