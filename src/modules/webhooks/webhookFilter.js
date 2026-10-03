'use strict';

/**
 * An endpoint's optional filter (SPEC §16.1): only events about these funnels
 * or products. Stored as { funnelIds: [...], productIds: [...] }.
 *
 * `subject` is what an event is about: { funnelId, productIds }. An event
 * passes when it touches any listed funnel or product. An event that is
 * about neither a funnel nor a product (a new customer, a contact form) is
 * not something the filter can judge, so it passes.
 */

const clean = (list) => [...new Set((Array.isArray(list) ? list : []).filter(Boolean).map(String))];

/** The filter as stored: null when it filters nothing. */
function normaliseFilter(filter) {
  if (!filter) return null;
  const funnelIds = clean(filter.funnelIds);
  const productIds = clean(filter.productIds);
  if (funnelIds.length === 0 && productIds.length === 0) return null;
  return { funnelIds, productIds };
}

function matchesFilter(endpoint, subject = {}) {
  const filter = normaliseFilter(endpoint.filter);
  if (!filter) return true;
  const funnelId = subject.funnelId ? String(subject.funnelId) : null;
  const productIds = clean(subject.productIds);
  if (!funnelId && productIds.length === 0) return true;
  if (funnelId && filter.funnelIds.includes(funnelId)) return true;
  return productIds.some((id) => filter.productIds.includes(id));
}

module.exports = { normaliseFilter, matchesFilter };
