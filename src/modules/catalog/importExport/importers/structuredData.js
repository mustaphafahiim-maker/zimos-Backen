'use strict';

/*
 * A product page's public structured data → one transfer product
 * (productTransfer's import shape, as a draft), with the reviews the page
 * itself publishes. Reads schema.org JSON-LD (`Product`, also inside
 * @graph), and falls back to Open Graph tags for the name, picture and price.
 */

const MAX_REVIEWS = 50;
const MAX_IMAGES = 20;

const decode = (s) =>
  String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (s, max) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* a broken block is skipped */
    }
  }
  return out;
}

function flatten(node, acc = []) {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, acc));
  else if (node && typeof node === 'object') {
    acc.push(node);
    if (node['@graph']) flatten(node['@graph'], acc);
  }
  return acc;
}

const isType = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).toLowerCase() === t);

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop.replace(/[.:]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop.replace(/[.:]/g, '\\$&')}["']`, 'i'));
  return m ? decode(m[1]).trim() : null;
}

function money(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u.slice(0, 1000) : null);

function images(value) {
  return [].concat(value || [])
    .map((i) => (typeof i === 'string' ? i : i && (i.url || i.contentUrl)))
    .map(httpsUrl)
    .filter(Boolean);
}

function reviewsOf(product) {
  return [].concat(product.review || product.reviews || [])
    .map((r) => {
      const rating = Math.round(Number((r.reviewRating && r.reviewRating.ratingValue) ?? r.ratingValue));
      const best = Number((r.reviewRating && r.reviewRating.bestRating) || 5);
      const scaled = best && best !== 5 ? Math.round((rating / best) * 5) : rating;
      const author = typeof r.author === 'string' ? r.author : r.author && r.author.name;
      return {
        authorName: text(author || '', 120) || null,
        rating: scaled,
        comment: text(r.reviewBody || r.description || '', 2000) || null,
        date: r.datePublished || null,
      };
    })
    .filter((r) => r.rating >= 1 && r.rating <= 5)
    .slice(0, MAX_REVIEWS);
}

function readStructuredProduct(html, { source, url }) {
  const nodes = flatten(jsonLdBlocks(html));
  const p = nodes.find((n) => isType(n, 'product'));
  const offersRaw = p && p.offers ? [].concat(p.offers) : [];
  const offer = offersRaw[0] || {};
  const price = money(offer.price ?? offer.lowPrice ?? meta(html, 'product:price:amount') ?? meta(html, 'og:price:amount'));
  const currency = String(offer.priceCurrency || meta(html, 'product:price:currency') || '').toUpperCase() || null;
  const name = text((p && p.name) || meta(html, 'og:title') || '', 300);
  if (!name) return null;
  const pics = [...new Set([...images(p && p.image), ...images(meta(html, 'og:image'))])].slice(0, MAX_IMAGES);
  const description = text((p && p.description) || meta(html, 'og:description') || '', 5000);
  return {
    __row: 1,
    name,
    // The page's price is in its own currency (`sourceCurrency`): the merchant checks it before publishing.
    description: `${description}${currency ? `\n\n(Imported price: ${(price || 0) / 100} ${currency})` : ''}`.trim(),
    productType: 'physical',
    status: 'draft',
    tags: [`import:${source}`],
    media: pics.map((u) => ({ url: u })),
    options: [],
    collections: [],
    variants: [{ sku: (p && p.sku && String(p.sku).slice(0, 100)) || null, optionValues: {}, priceAmount: price || 0, compareAtAmount: null, stockOnHand: 0, weightGrams: null }],
    reviews: p ? reviewsOf(p) : [],
    sourceUrl: url,
    sourceCurrency: currency,
  };
}

module.exports = { readStructuredProduct, jsonLdBlocks };
