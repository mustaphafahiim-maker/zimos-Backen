'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * Tags from website pages (SPEC §18.4 [LF]: "any submit or purchase button in
 * the builder can add a tag to the customer"), the store's side of what
 * funnels/funnelTags.js does for funnel steps.
 *
 * A page's buy button (`button`) or order form (`cod_form`) carries
 * `contactTags`. The storefront remembers which of them the shopper used —
 * a press of the button, or filling in the form — and sends only where they
 * are with the order:
 *
 *   checkout body  pageTags: [{ pageId, elementId }]   (at most 10)
 *
 * The tags themselves are read here from the store's *published* website, so
 * a shopper can never pick their own tags. They are added to the order's
 * customer once the order exists; anything that does not resolve (a page
 * since unpublished, an element removed) adds nothing.
 */

const TAGGING_TYPES = new Set(['button', 'cod_form']);

function findElement(node, id, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node.type === 'string' && node.id !== undefined && String(node.id) === id) return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'props' || !value || typeof value !== 'object') continue;
    const hit = findElement(value, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const tagsOf = (props) => {
  const raw = props && props.contactTags;
  return Array.isArray(raw) ? raw : String(raw || '').split(',');
};

/** The tags the referenced elements of the store's published website carry. */
async function resolveTags(workspaceId, refs) {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const website = await db.Website.findOne({
    where: { workspaceId, status: 'published' },
    order: [['updatedAt', 'DESC']],
    attributes: ['id', 'publishedRevisionId'],
  });
  if (!website || !website.publishedRevisionId) return [];
  const revision = await db.WebsiteRevision.findOne({ where: { id: website.publishedRevisionId, websiteId: website.id }, attributes: ['snapshot'] });
  const pages = revision && revision.snapshot && Array.isArray(revision.snapshot.pages) ? revision.snapshot.pages : [];
  const tags = [];
  for (const ref of refs.slice(0, 10)) {
    const page = pages.find((p) => p && p.id && String(p.id) === String(ref.pageId));
    const element = page ? findElement(page.data, String(ref.elementId)) : null;
    if (element && TAGGING_TYPES.has(element.type)) tags.push(...tagsOf(element.props));
  }
  return require('./contactService').cleanTags(tags);
}

/** Adds the pages' tags to the order's customer. Never throws: the order is placed whatever happens here. */
async function tagFromPages(workspaceId, order, refs) {
  try {
    const tags = await resolveTags(workspaceId, refs);
    if (tags.length === 0 || !order || !order.customerId) return [];
    return await db.sequelize.transaction(async (transaction) => {
      const customer = await db.Customer.findOne({ where: { id: order.customerId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!customer) return [];
      const before = customer.tags || [];
      const after = require('./contactService').cleanTags([...before, ...tags]);
      if (after.length === before.length) return [];
      await customer.update({ tags: after }, { transaction });
      return after.filter((t) => !before.includes(t));
    });
  } catch (err) {
    logger.warn('Page tags not added', { workspaceId, orderId: order && order.id, message: err.message });
    return [];
  }
}

module.exports = { resolveTags, tagFromPages };
