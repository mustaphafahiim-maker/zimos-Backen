'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');

/*
 * The test importer: answers any Shopify-style product link
 * (https://<shop>/products/<handle>) with the same twelve reviews every time
 * for that link, so filters and de-duplication can be tried end to end. Every
 * one says it is a sandbox review and none is a real customer's — they are for
 * a test store, never a live one (index.js refuses the sandbox in production).
 * Photos point at a public placeholder image service.
 */

const name = 'Sandbox';
const sandbox = true;

const COMMENTS = {
  en: ['Sandbox review — testing the import.', 'Sandbox review with a photo — testing the import.'],
  ar: ['تقييم تجريبي (sandbox) — لاختبار الاستيراد.', 'تقييم تجريبي (sandbox) بصورة — لاختبار الاستيراد.'],
};

async function fetchReviews({ url, limit = 200 }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  const handle = parsed && (parsed.pathname.match(/\/products\/([^/?#]+)/) || [])[1];
  if (!handle) {
    throw new AppError('REVIEW_IMPORT_BAD_LINK', 'Paste the link of one product page (…/products/<name>)', 422);
  }
  const seed = crypto.createHash('sha256').update(`${parsed.host}/${handle}`).digest();
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    const language = i % 3 === 2 ? 'en' : 'ar';
    const withPhoto = i % 4 === 0;
    rows.push({
      externalId: `sandbox-${handle}-${i + 1}`,
      authorName: `Sandbox reviewer ${i + 1}`,
      rating: 1 + (seed[i] % 5),
      comment: COMMENTS[language][withPhoto ? 1 : 0],
      photos: withPhoto ? [`https://placehold.co/600x450/png?text=Sandbox+${i + 1}`] : [],
      language,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    });
  }
  return rows.slice(0, limit);
}

module.exports = { name, sandbox, fetchReviews };
