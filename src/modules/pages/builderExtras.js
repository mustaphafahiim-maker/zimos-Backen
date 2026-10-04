'use strict';

/**
 * Builder elements of SPEC §9.3 added after the first set (item 44): typed
 * props like every other element — never markup — registered into
 * pageTree.js's allowlist and prop rules from here, so that file only gains
 * two lines (as showcaseElements.js does).
 *
 *   image_gallery     a big picture with a row of thumbnails; the page
 *                     product's pictures when it has none of its own
 *   variant_selector  the product's options as chips; the choice is what the
 *                     order form and the funnel checkout start from
 *   bundle_selector   the product's quantity offers ("2 for …") to pick from
 *   review_form       the shopper's review form for the product (order number
 *                     + phone, photos — reviews/shopperReviews.js)
 *   popup             a window over the page: opened by any link to
 *                     "#popup-<key>", after a delay, or when the pointer
 *                     leaves the page — shown once a visit for the last two
 *
 * A "container" is not an element: every column is a flex box, and its
 * layout settings (stacked or side by side, gap, alignment) live on the
 * column like its other settings.
 *
 * Every prop is optional: the builder autosaves half-filled elements.
 */

const TYPES = ['image_gallery', 'variant_selector', 'bundle_selector', 'review_form', 'popup'];

/**
 * @param {object} check pageTree.js's rule builders
 * @returns {object} ELEMENT_PROP_RULES entries, keyed by element type
 */
function propRules(check) {
  return {
    image_gallery: {
      title: check.string(300),
      images: check.listOf(20, check.url),
      productId: check.uuid,
      thumbnails: check.oneOf('below', 'side'),
    },
    variant_selector: { title: check.string(200), productId: check.uuid, showPrice: check.bool },
    bundle_selector: { title: check.string(200), productId: check.uuid },
    review_form: { title: check.string(300), productId: check.uuid },
    popup: {
      key: (v) => (typeof v === 'string' && /^[a-z0-9-]{0,40}$/.test(v) ? null : 'must be up to 40 lowercase letters, digits or hyphens'),
      title: check.string(200),
      text: check.string(2000),
      image: check.url,
      buttonLabel: check.string(100),
      buttonHref: check.url,
      trigger: check.oneOf('click', 'delay', 'exit'),
      delaySeconds: check.intRange(1, 120),
    },
  };
}

module.exports = { TYPES, propRules };
