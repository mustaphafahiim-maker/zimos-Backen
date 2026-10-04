'use strict';

const db = require('../../db/models');

/**
 * A product's own landing page (SPEC §7.3 page settings `landing_page_id`): a
 * page of the store's website, built in the page builder, shown at the
 * product's address in place of the standard product page, with the product
 * as the page's product. Only a page that is on counts, and the storefront
 * shows the standard page when it is not in the published website.
 */
async function landingPathFor(workspaceId, pageSettings) {
  const id = pageSettings && pageSettings.landing_page_id;
  if (!id) return null;
  const page = await db.WebsitePage.findOne({ where: { id, workspaceId }, attributes: ['path', 'isActive'] });
  // The storefront still checks the page is in the published website, and falls back if not.
  if (!page || page.isActive === false) return null;
  return page.path;
}

module.exports = { landingPathFor };
