'use strict';

/**
 * What can be measured about a page tree without guessing (feature
 * `page_review`, item 97): where the order form and the buttons sit, the
 * pictures and whether they are described, the trust blocks it has. The
 * provider gets these as facts; the sandbox provider scores from them.
 */

const ORDER_TYPES = new Set(['form', 'cod_form', 'checkout_summary', 'upsell_accept_button']);
const CTA_TYPES = new Set(['button', 'text_link', 'cod_form', 'upsell_accept_button', 'product_card']);
const PROOF_TYPES = new Set(['testimonial', 'reviews_list', 'stars_display']);
const FAQ_TYPES = new Set(['faq', 'accordion']);
const IMAGE_TYPES = new Set(['image', 'gallery', 'carousel', 'image_gallery', 'masonry_grid']);
const TEXT_KEYS = ['text', 'title', 'label', 'quote', 'subtitle'];
const GUARANTEE = /(ضمان|استرجاع|استرداد|guarantee|money.?back|refund|return)/i;
const PRICE_TYPES = new Set(['price', 'product_card', 'cod_form', 'bundle_selector', 'product_list']);

function elementsOf(tree) {
  const out = [];
  (tree && Array.isArray(tree.sections) ? tree.sections : []).forEach((section, sectionIndex) => {
    for (const row of (section && section.rows) || []) {
      for (const column of (row && row.columns) || []) {
        for (const el of (column && column.elements) || []) if (el && typeof el === 'object') out.push({ el, sectionIndex });
      }
    }
  });
  return out;
}

function textOf(el) {
  const props = el.props || {};
  return TEXT_KEYS.map((k) => (typeof props[k] === 'string' ? props[k] : '')).join(' ');
}

function imagesOf(el) {
  const props = el.props || {};
  if (el.type === 'image') return [{ src: props.src, alt: props.alt }];
  const list = Array.isArray(props.images) ? props.images : Array.isArray(props.items) && el.type === 'masonry_grid' ? props.items.map((i) => i && i.image) : [];
  return list.map((src) => ({ src, alt: el.type === 'masonry_grid' ? 'caption' : '' }));
}

/** Facts about a page tree, all counted from it. */
function pageFacts(tree) {
  const sections = tree && Array.isArray(tree.sections) ? tree.sections.length : 0;
  const all = elementsOf(tree);
  const firstIndex = (set) => {
    const hit = all.find(({ el }) => set.has(el.type));
    return hit ? hit.sectionIndex + 1 : null;
  };
  const images = all.flatMap(({ el }) => (IMAGE_TYPES.has(el.type) ? imagesOf(el) : [])).filter((i) => i.src);
  const words = all.map(({ el }) => textOf(el)).join(' ');
  return {
    sections,
    elements: all.length,
    orderFormSection: firstIndex(ORDER_TYPES),
    firstCallToActionSection: firstIndex(CTA_TYPES),
    callsToAction: all.filter(({ el }) => CTA_TYPES.has(el.type)).length,
    showsPrice: all.some(({ el }) => PRICE_TYPES.has(el.type)),
    images: images.length,
    imagesWithoutDescription: images.filter((i) => !String(i.alt || '').trim()).length,
    videos: all.filter(({ el }) => el.type === 'video').length,
    socialProof: all.filter(({ el }) => PROOF_TYPES.has(el.type)).length,
    faq: all.some(({ el }) => FAQ_TYPES.has(el.type)),
    guaranteeMentioned: GUARANTEE.test(words),
    countdown: all.some(({ el }) => el.type === 'countdown'),
    words: words.split(/\s+/).filter(Boolean).length,
  };
}

/** The page as short lines, one per section: what a reviewer reads. */
function pageOutline(tree) {
  const lines = [];
  (tree && Array.isArray(tree.sections) ? tree.sections : []).forEach((section, i) => {
    const parts = [];
    for (const row of (section && section.rows) || []) {
      for (const column of (row && row.columns) || []) {
        for (const el of (column && column.elements) || []) {
          const snippet = textOf(el).replace(/\s+/g, ' ').trim().slice(0, 80);
          parts.push(snippet ? `${el.type}: "${snippet}"` : el.type);
        }
      }
    }
    lines.push(`${i + 1}. ${parts.join(' | ') || '(empty)'}`);
  });
  return lines.slice(0, 40).join('\n');
}

module.exports = { pageFacts, pageOutline };
