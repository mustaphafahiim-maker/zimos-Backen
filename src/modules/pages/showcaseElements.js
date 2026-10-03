'use strict';

/**
 * The "showcase" sections: full-width storefront bands a home page is built
 * from — an image slider, category tiles, a trust strip, product rails, a
 * video shelf, a picture banner. They are ordinary page-tree elements (typed
 * props, never markup), registered into pageTree.js's allowlist and prop
 * rules from here so that file only gains two lines.
 *
 * Every prop is optional, like the other newer types: the builder autosaves
 * half-filled sections, so these rules police shape and size, not presence.
 * Text props may come with an `…En` twin — the storefront shows it when the
 * shopper switches the store to English and falls back to the main one.
 */

const TYPES = [
  'hero_slider',
  'category_tiles',
  'trust_strip',
  'bundle_cards',
  'need_picker',
  'product_rail',
  'video_reels',
  'product_shelf',
  'product_cards',
  'image_banner',
];

const TONES = ['plain', 'primary', 'secondary', 'cool'];
const TRUST_ICONS = ['box', 'cash', 'truck', 'shield', 'support', 'return', 'gift', 'clock', 'heart', 'star'];
const NEED_ICONS = ['moon', 'bottle', 'bag', 'clock', 'box', 'heart', 'star', 'gift', 'home', 'sun'];

const bool = (v) => (typeof v === 'boolean' ? null : 'must be true or false');

/**
 * @param {object} check pageTree.js's rule builders (string, url, intRange, oneOf, listOf, shape)
 * @returns {object} ELEMENT_PROP_RULES entries, keyed by element type
 */
function propRules(check) {
  const text = check.string(300);
  const long = check.string(1200);
  const label = check.string(120);
  // A product or collection is named by id or slug — the storefront API takes either.
  const ref = check.string(300);
  const tone = check.oneOf(...TONES);

  const productBand = {
    heading: text,
    headingEn: text,
    subheading: check.string(600),
    subheadingEn: check.string(600),
    collection: ref,
    limit: check.intRange(1, 24),
    showDiscount: bool,
    imageFit: check.oneOf('contain', 'cover'),
    buttonLabel: label,
    buttonLabelEn: label,
    buttonHref: check.url,
    cartLabel: label,
    cartLabelEn: label,
    tone,
  };

  return {
    hero_slider: {
      slides: check.listOf(
        8,
        check.shape({
          image: check.url,
          mobileImage: check.url,
          imageEn: check.url,
          mobileImageEn: check.url,
          alt: text,
          eyebrow: text,
          eyebrowEn: text,
          heading: text,
          headingEn: text,
          subheading: check.string(600),
          subheadingEn: check.string(600),
          buttonLabel: label,
          buttonLabelEn: label,
          buttonHref: check.url,
          side: check.oneOf('start', 'center', 'end'),
          vertical: check.oneOf('top', 'middle', 'bottom'),
          contentWidth: check.intRange(200, 900),
          text: check.oneOf('dark', 'light'),
        })
      ),
      autoplay: bool,
      seconds: check.intRange(2, 30),
      startDelay: check.intRange(0, 120),
      arrows: bool,
      dots: bool,
      wave: bool,
      height: check.intRange(240, 900),
      heightTablet: check.intRange(240, 900),
      label,
      labelEn: label,
    },
    category_tiles: {
      heading: text,
      headingEn: text,
      items: check.listOf(
        24,
        check.shape({ image: check.url, title: text, titleEn: text, href: check.url })
      ),
      columns: check.intRange(2, 6),
      columnsMobile: check.intRange(2, 4),
      tone,
    },
    trust_strip: {
      items: check.listOf(
        8,
        check.shape({
          icon: check.oneOf(...TRUST_ICONS),
          title: text,
          titleEn: text,
          text: check.string(600),
          textEn: check.string(600),
        })
      ),
      tone,
    },
    bundle_cards: {
      ...productBand,
      badge: label,
      badgeEn: label,
      mobileOnly: bool,
    },
    need_picker: {
      kicker: text,
      kickerEn: text,
      heading: text,
      headingEn: text,
      sub: check.string(600),
      subEn: check.string(600),
      ctaLabel: label,
      ctaLabelEn: label,
      moreLabel: label,
      moreLabelEn: label,
      // "[amount]" is replaced by the saving, e.g. "وفّري [amount] جنيه".
      saveLabel: label,
      saveLabelEn: label,
      stages: check.listOf(
        8,
        check.shape({
          icon: check.oneOf(...NEED_ICONS),
          name: text,
          nameEn: text,
          pain: text,
          painEn: text,
          desc: long,
          descEn: long,
          items: check.listOf(6, text),
          itemsEn: check.listOf(6, text),
          productId: ref,
          altProductId: ref,
          image: check.url,
        })
      ),
      tone,
    },
    product_rail: {
      ...productBand,
      autoplay: bool,
      speed: check.oneOf('slow', 'normal', 'fast'),
    },
    video_reels: {
      heading: text,
      headingEn: text,
      subheading: check.string(600),
      subheadingEn: check.string(600),
      items: check.listOf(
        12,
        check.shape({ video: check.url, poster: check.url, productId: ref })
      ),
      tone,
    },
    product_shelf: {
      ...productBand,
      showSoldOut: bool,
    },
    product_cards: {
      ...productBand,
      columns: check.intRange(2, 6),
    },
    image_banner: {
      image: check.url,
      mobileImage: check.url,
      alt: text,
      heading: text,
      headingEn: text,
      text: check.string(600),
      textEn: check.string(600),
      buttonLabel: label,
      buttonLabelEn: label,
      buttonHref: check.url,
      height: check.intRange(200, 900),
      heightTablet: check.intRange(200, 900),
      heightMobile: check.intRange(200, 900),
      wave: bool,
    },
  };
}

module.exports = { TYPES, TONES, TRUST_ICONS, NEED_ICONS, propRules };
