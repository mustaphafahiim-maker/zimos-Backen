'use strict';

const db = require('../../db/models');
const { AuthorizationError, ValidationError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const { assertInt, multiplyByQuantity, applyBasisPoints } = require('../../core/utils/money');

/**
 * Staff price changes on an order (item 382): what a merchant does when they
 * type an order in by hand or edit one — a line at another price, a line that
 * is not in the catalogue, a discount on the whole order.
 *
 *   items[].unitPrice      a catalogue line at this unit price (minor units). The
 *                          catalogue's price stays on the line, in priceOverride,
 *                          to compare; a quantity bundle's tier never applies on top.
 *   items[] { title, unitPrice, quantity, sku?, weightGrams? }
 *                          a custom line: no product, no variant, no stock held.
 *                          Without weightGrams it weighs nothing.
 *   manualDiscount { type: amount|percent, value, reason }
 *                          taken off what is left after the code or automatic
 *                          discount, never more than that (the goods never go
 *                          below 0). Kept in discountsSnapshot as its own entry,
 *                          kind 'manual', with the reason and who gave it — apart
 *                          from the coupon. order.discountAmount is both together.
 *
 * Only staff with orders.price_override (Owner always) may send them, on the
 * dashboard's own routes: createOrder refuses them from a shopper (no req.user),
 * and an API key's scopes never grant the permission. Every change is audited
 * with the catalogue prices as `before`.
 */

const MANUAL = 'manual';

const isCustom = (item) => Boolean(item) && !item.variantId && typeof item.title === 'string';
const hasUnitPrice = (item) => Boolean(item) && item.unitPrice !== undefined && item.unitPrice !== null;

function canChangePrices(req) {
  return Boolean(req && req.user && req.tenant && typeof req.tenant.hasPermission === 'function' && req.tenant.hasPermission(PERMISSIONS.ORDERS_PRICE_OVERRIDE));
}

function forbidden() {
  return new AuthorizationError(`Missing required permission: ${PERMISSIONS.ORDERS_PRICE_OVERRIDE}`);
}

/** Whether a create / preview body changes a price at all. */
function asksForPrices(payload) {
  if (!payload) return false;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items.some((i) => isCustom(i) || hasUnitPrice(i)) || (payload.manualDiscount !== undefined && payload.manualDiscount !== null);
}

/** createOrder's gate: a body with staff prices needs a signed-in teammate with the permission. */
function assertAllowedFor(payload, req) {
  if (asksForPrices(payload) && !canChangePrices(req)) throw forbidden();
  if (payload && payload.manualDiscount) checkManual(payload.manualDiscount);
}

/** The same rules as the request schema, for callers that skip it. */
function checkManual(md) {
  const bad = (message) => new ValidationError([{ field: 'manualDiscount', message }]);
  if (!md || typeof md !== 'object') throw bad('Must be an object');
  if (md.type !== 'amount' && md.type !== 'percent') throw bad('type must be amount or percent');
  const value = Number(md.value);
  if (!Number.isFinite(value) || value < 0) throw bad('value must be 0 or more');
  if (md.type === 'percent' && value > 100) throw bad('A percentage is at most 100');
  if (md.type === 'amount' && !Number.isInteger(value)) throw bad('An amount is in minor units (a whole number)');
  if (typeof md.reason !== 'string' || !md.reason.trim()) throw bad('reason is required');
}

const actorOf = (req) => (req && req.user ? { actorUserId: req.user.id, actorName: req.user.fullName || null } : { actorUserId: null, actorName: null });

/** A custom line, priced like priceLine's answer: nothing in stock, no product. */
function customLine(item, req, kept = null) {
  const unitPriceAmount = assertInt(item.unitPrice, 'unitPrice');
  if (unitPriceAmount < 0) throw new ValidationError([{ field: 'items.unitPrice', message: 'unitPrice must be 0 or more' }]);
  const weightGrams = item.weightGrams === undefined || item.weightGrams === null ? null : assertInt(item.weightGrams, 'weightGrams');
  return {
    kept,
    custom: true,
    productId: null,
    productName: String(item.title).trim(),
    variantId: null,
    variantOptions: null,
    sku: item.sku ? String(item.sku).trim() : null,
    offerId: null,
    offerName: null,
    freeGift: false,
    quantity: item.quantity,
    unitPriceAmount,
    unitCostAmount: null,
    lineDiscountAmount: 0,
    lineTotalAmount: multiplyByQuantity(unitPriceAmount, item.quantity),
    consumedInventory: [],
    customFields: [],
    currency: null,
    shippingOverride: null,
    // Without a weight it adds none (a service, a fee); with one it counts like a product's.
    weightUnits: [weightGrams === null ? { weightGrams: null, quantity: 1, weightless: true } : { weightGrams, quantity: 1, weightless: false }],
    shippingRule: { mode: undefined, extraAmount: undefined, units: item.quantity, profileId: null },
    priceOverride: kept && kept.priceOverride ? kept.priceOverride : { kind: 'custom', ...actorOf(req), at: new Date().toISOString() },
  };
}

/**
 * A catalogue line at the price staff typed. `catalogUnitPriceAmount` is what the
 * line would have cost (the catalogue's price, or the price an edited line was sold at).
 * A price equal to that is no change: the line stays a plain catalogue line.
 */
function overrideLine(line, unitPrice, req, catalogUnitPriceAmount = line.unitPriceAmount) {
  const price = assertInt(unitPrice, 'unitPrice');
  if (price < 0) throw new ValidationError([{ field: 'items.unitPrice', message: 'unitPrice must be 0 or more' }]);
  line.unitPriceAmount = price;
  line.lineTotalAmount = multiplyByQuantity(price, line.quantity);
  line.lineDiscountAmount = 0;
  line.priceOverride = price === Number(catalogUnitPriceAmount)
    ? null
    : { kind: 'override', catalogUnitPriceAmount: String(catalogUnitPriceAmount), ...actorOf(req), at: new Date().toISOString() };
  return line;
}

/** Custom lines take the order's currency: its other lines', or the store's. */
async function settleCurrency(workspaceId, lines, transaction) {
  if (!lines.some((l) => l.custom && !l.currency)) return;
  const other = lines.find((l) => !l.custom && l.currency);
  const currency = other
    ? other.currency
    : (await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultCurrency'], transaction })).defaultCurrency;
  for (const line of lines) if (line.custom && !line.currency) line.currency = currency;
}

/** The order's manual discount entry, or null. */
function manualOf(order) {
  return ((order && order.discountsSnapshot) || []).find((d) => d && d.kind === MANUAL) || null;
}

/**
 * The manual discount on `base` (what is left after the code): an amount up to
 * `base`, or a percentage of it rounded half-up. `previous` keeps who gave it
 * when an edit carries it over unchanged.
 */
function manualEntry(md, base, req, previous = null) {
  if (!md) return null;
  checkManual(md);
  const room = Math.max(0, assertInt(base, 'base'));
  const value = md.type === 'percent' ? Number(md.value) : assertInt(md.value, 'value');
  const wanted = md.type === 'percent' ? applyBasisPoints(room, Math.round(value * 100)) : value;
  const amount = Math.max(0, Math.min(wanted, room));
  const who = previous ? { actorUserId: previous.actorUserId || null, actorName: previous.actorName || null, at: previous.at } : { ...actorOf(req), at: new Date().toISOString() };
  return { kind: MANUAL, type: md.type, value, reason: String(md.reason).trim(), amount, ...who };
}

const sameManual = (a, b) =>
  (!a && !b) || (Boolean(a) && Boolean(b) && a.type === b.type && Number(a.value) === Number(b.value) && String(a.reason || '').trim() === String(b.reason || '').trim());

/**
 * The lines calculateTax taxes, after the code's discount (on its covered lines)
 * and then the manual discount (on every line).
 */
async function taxableLines(lines, couponAmount, couponRecord, manualAmount, transaction) {
  const taxService = require('../tax/taxService');
  const afterCoupon = await taxService.taxableLines(lines, couponAmount, couponRecord, transaction);
  if (!manualAmount) return afterCoupon;
  return taxService.taxableLines(afterCoupon.map((l) => ({ productId: l.productId, lineTotalAmount: l.lineTotal })), manualAmount, null, transaction);
}

/** The audit's before / after for the price changes of a new order; null when there were none. */
function auditOfCreate(lines, manual) {
  const changed = lines.filter((l) => l.priceOverride);
  if (!changed.length && !manual) return null;
  const name = (l) => l.productName;
  return {
    before: {
      lines: changed.map((l) => ({ name: name(l), quantity: l.quantity, unitPriceAmount: l.custom ? null : l.priceOverride.catalogUnitPriceAmount })),
      manualDiscount: null,
    },
    after: {
      lines: changed.map((l) => ({ name: name(l), quantity: l.quantity, unitPriceAmount: String(l.unitPriceAmount), custom: Boolean(l.custom), sku: l.sku || null })),
      manualDiscount: manual,
    },
  };
}

/** How an item reads in API answers: whether staff priced it, and the catalogue price to compare. */
function presentLine(item) {
  const p = item.priceOverride || null;
  return {
    custom: Boolean(p && p.kind === 'custom'),
    priceOverride: p,
  };
}

module.exports = {
  MANUAL,
  isCustom,
  hasUnitPrice,
  canChangePrices,
  forbidden,
  asksForPrices,
  assertAllowedFor,
  checkManual,
  customLine,
  overrideLine,
  settleCurrency,
  manualOf,
  manualEntry,
  sameManual,
  taxableLines,
  auditOfCreate,
  presentLine,
};
