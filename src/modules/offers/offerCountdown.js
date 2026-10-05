'use strict';

const { AppError } = require('../../core/errors/AppError');

/**
 * The real countdown of a one-click offer (SPEC §9.5; offers.countdown_minutes).
 *
 *   funnel upsell / downsell   from when the session reached the offer step
 *                              (the session row is not written while it sits
 *                              there, so its updatedAt is that moment)
 *   store thank-you upsell     from when the order was placed
 *
 * The shopper sees the deadline (`expiresAt`); taking the offer after it is
 * refused, with a short grace for a tap made as the clock ran out.
 */

const GRACE_MS = 30 * 1000;

function deadline(offer, startedAt) {
  const minutes = Number(offer && offer.countdownMinutes);
  if (!minutes || minutes <= 0 || !startedAt) return null;
  return new Date(new Date(startedAt).getTime() + minutes * 60 * 1000);
}

/** Throws `error()` once the offer's time is up (grace included); no countdown, no limit. */
function assertOpen(offer, startedAt, error, now = Date.now()) {
  const end = deadline(offer, startedAt);
  if (end && now > end.getTime() + GRACE_MS) throw error();
}

const funnelOfferExpired = () => new AppError('FUNNEL_OFFER_EXPIRED', 'This offer has ended', 404);
const upsellExpired = () => new AppError('UPSELL_CLOSED', 'This offer has ended', 409);

module.exports = { deadline, assertOpen, funnelOfferExpired, upsellExpired, GRACE_MS };
