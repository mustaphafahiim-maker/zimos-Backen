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
 *   masonry_grid      pictures of their own heights in 2–5 columns, each with
 *                     an optional caption and link (item 93)
 *
 * A "container" is not an element: every column is a flex box, and its
 * layout settings (stacked or side by side, gap, alignment) live on the
 * column like its other settings.
 *
 * Every prop is optional: the builder autosaves half-filled elements.
 */

const TYPES = ['image_gallery', 'variant_selector', 'bundle_selector', 'review_form', 'popup', 'masonry_grid'];

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
    masonry_grid: {
      title: check.string(300),
      items: check.listOf(40, check.shape({ image: check.url, caption: check.string(200), href: check.url })),
      columns: check.intRange(2, 5),
    },
  };
}

/**
 * Props item 93 adds to elements that already had rules (or none): merged
 * into ELEMENT_PROP_RULES after the rest, so each type keeps its own.
 *
 *   button  what it does: follow its link (the default), put the product in
 *           the cart, or put it there and go to the checkout. The product is
 *           `productId` ("" = the page's product); the variant is the one the
 *           shopper picked on the page, else `variantId`, else the first in
 *           stock.
 *   form    one photo input (`fileLabel`, required with `fileRequired`) and
 *           one 1–5 stars input (`ratingLabel`); contacts/formFiles.js reads
 *           them from the published page when the form is sent.
 *
 * A column's "sticky" (stays in view while the page scrolls, on a computer)
 * is a column setting like its layout — read by the storefront, not checked.
 */
function extraRules(check) {
  return {
    button: {
      action: check.oneOf('link', 'add_to_cart', 'buy_now'),
      productId: check.uuid,
      variantId: check.uuid,
    },
    form: {
      fileLabel: check.string(100),
      fileRequired: check.bool,
      ratingLabel: check.string(100),
    },
  };
}

module.exports = { TYPES, propRules, extraRules };
