'use strict';

const https = require('https');
const { ValidationError, AppError } = require('../../../../core/errors/AppError');
const { guardedLookup } = require('../../../webhooks/webhookUrlGuard');
const { readStructuredProduct } = require('./structuredData');

/*
 * Import a product (and its reviews) from a link on another platform
 * (Lightfunnels' AliExpress / Etsy / CJ / YouCan importers; README.md here).
 * Beside the Shopify link importer (productTransfer.fromShopifyLink).
 *
 * Each source is an adapter { name, matches(url), read(url) → transfer product }.
 * The working reader for all four is the product page's public structured
 * data (schema.org JSON-LD Product, else Open Graph): name, description,
 * pictures, price, SKU and the reviews the page publishes. Official API
 * adapters (AliExpress DS, CJ, Etsy Open API) need the owner's app keys and
 * go beside these (README.md).
 *
 * PRODUCT_IMPORT_MODE=sandbox answers every supported link with a sample
 * product named as such and NO reviews — a review is never made up (SPEC §21).
 */

const SOURCES = [
  { name: 'aliexpress', hosts: /(^|\.)aliexpress\.(com|us|ru)$|(^|\.)aliexpress\.[a-z]{2,3}$/i },
  { name: 'etsy', hosts: /(^|\.)etsy\.com$/i },
  { name: 'cj', hosts: /(^|\.)cjdropshipping\.com$/i },
  { name: 'youcan', hosts: /(^|\.)youcan\.(shop|store)$/i },
];

function parseLink(link) {
  const invalid = (message) => new ValidationError([{ field: 'url', message }]);
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw invalid('Paste the full product link, starting with https://');
  }
  if (url.protocol !== 'https:') throw invalid('The link must start with https://');
  if (url.username || url.password) throw invalid('The link must not contain a username or password');
  return url;
}

/** The source a link belongs to, or null (then it is not one of these importers'). */
function detect(link) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    return null;
  }
  const source = SOURCES.find((s) => s.hosts.test(url.hostname));
  return source ? source.name : null;
}

/** GET of a public HTML page: https only, public addresses only, no redirects followed, 3MB at most. */
function fetchPublicHtml(url, { timeoutMs = 12000, maxBytes = 3 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { lookup: guardedLookup, timeout: timeoutMs, headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (compatible; ZimosImporter/1.0)', 'accept-language': 'en' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`The page answered ${res.statusCode}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error('The page is too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
        return undefined;
      }
    );
    req.on('timeout', () => req.destroy(new Error('The page took too long to answer')));
    req.on('error', reject);
  });
}

function sandboxProduct(source, url) {
  const label = { aliexpress: 'AliExpress', etsy: 'Etsy', cj: 'CJ', youcan: 'YouCan' }[source];
  return {
    __row: 1,
    name: `Sample product from ${label} (sandbox)`,
    description: `Imported in sandbox mode from ${url.href}. Replace this text and the price before publishing.`,
    productType: 'physical',
    status: 'draft',
    tags: [`import:${source}`],
    media: [],
    options: [],
    collections: [],
    variants: [{ sku: null, optionValues: {}, priceAmount: 0, compareAtAmount: null, stockOnHand: 0, weightGrams: null }],
    reviews: [],
  };
}

/** A supported link → [transfer product] (one), with `reviews` the page publishes. */
async function fromLink(link) {
  const url = parseLink(link);
  const source = detect(url.href);
  if (!source) throw new ValidationError([{ field: 'url', message: 'Links from AliExpress, Etsy, CJ, YouCan or a Shopify store can be imported' }]);
  if (process.env.PRODUCT_IMPORT_MODE === 'sandbox') return { source, products: [sandboxProduct(source, url)] };
  let html;
  try {
    html = await fetchPublicHtml(url.href);
  } catch (err) {
    throw new AppError('IMPORT_SOURCE_UNREACHABLE', `Could not read the product from that link: ${err.message}`, 422, [{ field: 'url', message: err.message }]);
  }
  const product = readStructuredProduct(html, { source, url: url.href });
  if (!product) {
    throw new AppError('IMPORT_SOURCE_UNREACHABLE', 'That page does not publish its product details; download them as a sheet and import the file instead', 422, [{ field: 'url', message: 'No product data on the page' }]);
  }
  return { source, products: [product] };
}

module.exports = { fromLink, detect, SOURCES: SOURCES.map((s) => s.name) };
