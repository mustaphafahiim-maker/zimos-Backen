'use strict';

/**
 * All monetary values in this system are integers representing the minor
 * currency unit (e.g. piastres/cents), stored as Sequelize BIGINT columns.
 * JavaScript floating point is never used for money. Every function here
 * operates on integers only and throws if given a non-integer.
 */

/**
 * Sequelize/node-postgres return BIGINT columns as strings (a numeric value
 * can exceed JS's safe integer range), so any minor-unit amount read back
 * from the database arrives as e.g. "25000", not 25000. Every function here
 * accepts that shape and coerces it — the "integer minor units" contract is
 * about the VALUE being a whole number, not the JS typeof.
 */
function assertInt(value, name = 'amount') {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new TypeError(`${name} must be an integer minor-unit amount, got: ${value}`);
  }
  return n;
}

function add(...amounts) {
  return amounts.reduce((sum, a) => sum + assertInt(a), 0);
}

function subtract(a, b) {
  assertInt(a);
  assertInt(b);
  return a - b;
}

function multiplyByQuantity(unitAmount, quantity) {
  assertInt(unitAmount);
  assertInt(quantity, 'quantity');
  return unitAmount * quantity;
}

/**
 * Applies a basis-points percentage (e.g. 1500 = 15.00%) to an integer
 * amount using integer arithmetic (round-half-up), never floating point.
 */
function applyBasisPoints(amount, basisPoints) {
  assertInt(amount);
  assertInt(basisPoints, 'basisPoints');
  const numerator = amount * basisPoints;
  const quotient = Math.trunc(numerator / 10000);
  const remainder = numerator % 10000;
  // round-half-up
  if (Math.abs(remainder) * 2 >= 10000) {
    return quotient + Math.sign(numerator);
  }
  return quotient;
}

function toDisplay(amountMinorUnits, minorUnitDigits = 2) {
  assertInt(amountMinorUnits);
  const factor = 10 ** minorUnitDigits;
  return (amountMinorUnits / factor).toFixed(minorUnitDigits);
}

/**
 * Currency conversion: an integer amount times an exchange rate, rounded
 * half-up (away from zero) to the nearest minor unit. The rate is taken to 8
 * decimal places — the precision fx_rates stores — and the multiplication is
 * done in integers, so the result does not depend on floating-point rounding.
 */
function convertAmount(amount, rate) {
  const n = assertInt(amount);
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new TypeError(`rate must be a non-negative number, got: ${rate}`);
  const SCALE = 100000000n;
  const scaled = BigInt(Math.round(rate * 1e8));
  const product = BigInt(Math.abs(n)) * scaled;
  const rounded = (product + SCALE / 2n) / SCALE;
  return Number(n < 0 ? -rounded : rounded);
}

module.exports = { assertInt, add, subtract, multiplyByQuantity, applyBasisPoints, toDisplay, convertAmount };
