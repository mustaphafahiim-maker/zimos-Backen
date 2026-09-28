'use strict';

/**
 * Plan prices by billing cycle. The annual price is never set on its own: it
 * is always ANNUAL_PRICE_MONTHS × the monthly price (two months free against
 * paying monthly), so changing a plan's monthly price moves its annual price
 * with it.
 *
 * `plans.yearly_price_amount` is kept, written from this on every plan save
 * (and synced once by migration 110), so anything that still reads the
 * column agrees; the charge service, MRR and the billing views all price
 * through this module.
 */

const ANNUAL_PRICE_MONTHS = 10;
const BILLING_CYCLES = ['monthly', 'yearly'];

function yearlyPriceFor(monthlyPrice) {
  return Number(monthlyPrice) * ANNUAL_PRICE_MONTHS;
}

/** The price of one period of `plan` on `billingCycle`, in minor units. */
function planPrice(plan, billingCycle) {
  const monthly = Number(plan.monthlyPriceAmount);
  return billingCycle === 'yearly' ? yearlyPriceFor(monthly) : monthly;
}

/**
 * `date` plus `months` calendar months, in UTC, clamped to the last day of the
 * target month (31 Jan + 1 month = 28/29 Feb, not 3 Mar).
 */
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds()
    )
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** `date` plus one billing period: a month, or a full year for annual. */
function addBillingPeriod(date, billingCycle) {
  return addMonths(date, billingCycle === 'yearly' ? 12 : 1);
}

module.exports = { ANNUAL_PRICE_MONTHS, BILLING_CYCLES, yearlyPriceFor, planPrice, addMonths, addBillingPeriod };
