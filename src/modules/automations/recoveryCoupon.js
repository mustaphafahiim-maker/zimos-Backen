'use strict';

/**
 * The recovery link applies the automation's coupon (SPEC §6.4): in a
 * message that offers the coupon — one whose text or template parameters use
 * {{coupon_code}} — {{recovery_link}} carries it as `?coupon=`, which the
 * storefront applies at checkout (CouponFromLink, the /r/:token page). When
 * some messages of the automation name the coupon, the others keep the plain
 * link — a first reminder does not hand out the discount a later one offers.
 * When none names it, every link carries it: the link is then the only way
 * the coupon reaches the shopper.
 */

const MENTION = /\{\{\s*coupon_code\s*\}\}/;

function mentionsCoupon(step) {
  return MENTION.test(JSON.stringify([step.body, step.subject, step.message, step.params]));
}

/** The subject to run `step` (one of `allSteps`) with: unchanged unless the link should carry the coupon. */
function forStep(subject, step, couponCode, allSteps = []) {
  const link = subject && subject.vars && subject.vars.recovery_link;
  if (!couponCode || !link) return subject;
  if (!mentionsCoupon(step) && allSteps.some((s) => s && s.type !== 'wait' && mentionsCoupon(s))) return subject;
  const glue = link.includes('?') ? '&' : '?';
  return { ...subject, vars: { ...subject.vars, recovery_link: `${link}${glue}coupon=${encodeURIComponent(couponCode)}` } };
}

module.exports = { forStep, mentionsCoupon };
