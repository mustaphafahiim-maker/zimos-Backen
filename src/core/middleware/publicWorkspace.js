'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../errors/AppError');
const { isUuid, normalizeSlug } = require('../utils/workspaceSlug');
const { accessFor } = require('../../modules/workspaces/workspaceAccessService');

/**
 * Public storefront scoping (no membership check) — resolves the workspace
 * and sets req.tenant to the same { workspaceId } shape resolveTenant
 * produces, so downstream services behave identically for a shopper or a
 * staff member.
 *
 * A closed workspace 404s. A restricted one — suspended by a platform admin,
 * or unpaid past its grace day (workspaces/workspaceAccessService) — answers
 * 423 STORE_UNAVAILABLE on every public route, with just enough about the
 * store (name, locale) for the storefront to draw its "unavailable" page. No
 * catalogue, cart, checkout or order data is served.
 */
const resolvePublicWorkspace = asyncHandler(async (req, res, next) => {
  // A public store is addressed either by workspace UUID or by its slug, so
  // links minted before subdomain addressing keep working. Slugs are stored
  // lower-cased and hostnames are case-insensitive, so the lookup matches
  // however the shopper happened to type it.
  const ref = req.params.workspaceId;
  const workspace = await db.Workspace.findOne({
    where: {
      status: ['active', 'suspended'],
      ...(isUuid(ref) ? { id: ref } : { slug: normalizeSlug(ref) }),
    },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace');
  }

  const access = await accessFor(workspace.id, { workspace });
  if (access.restricted) {
    throw new AppError('STORE_UNAVAILABLE', 'This store is currently unavailable.', 423, {
      store: {
        name: workspace.name,
        slug: workspace.slug,
        defaultLocale: workspace.defaultLocale,
        logoUrl: workspace.logoUrl,
      },
    });
  }

  req.publicWorkspace = workspace;
  req.tenant = { workspaceId: workspace.id, hasPermission: () => false };
  next();
});

module.exports = { resolvePublicWorkspace };
