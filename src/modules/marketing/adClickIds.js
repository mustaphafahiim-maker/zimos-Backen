'use strict';

/*
 * The ad platforms' click ids beyond Meta / TikTok / Google / Snapchat
 * (spec-gaps item 254), as the URL parameter each one adds to its ad links,
 * and the platform each one means. They are kept on the visit and on the
 * first/last touch like fbclid/ttclid/gclid, so an order from such an ad is
 * credited to its platform even when the link has no utm_source.
 * (Outbrain and Kwai add no documented click id: their links need utm_source.)
 */

const EXTRA_CLICK_IDS = Object.freeze({ twclid: 'x', rdt_cid: 'reddit', msclkid: 'microsoft', tblci: 'taboola' });
const EXTRA_KEYS = Object.keys(EXTRA_CLICK_IDS);

/** The platform a touch's click id points at, among the extra ones, or null. */
const platformOfClick = (touch) => {
  if (!touch) return null;
  const key = EXTRA_KEYS.find((k) => touch[k]);
  return key ? EXTRA_CLICK_IDS[key] : null;
};

module.exports = { EXTRA_CLICK_IDS, EXTRA_KEYS, platformOfClick };
