'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');

/**
 * A store's previous addresses (SPEC §17.3: the subdomain can be changed in
 * account settings). Changing it would otherwise break every link already
 * handed out — ads, WhatsApp messages, printed cards — so the old address:
 *
 *   - keeps belonging to the store: no other store can take it (check-slug
 *     and the PATCH answer "taken"; a new store skips it);
 *   - sends visitors on: GET /store/resolve-host for <old>.<root> answers the
 *     store with `redirectTo` its current address (or its primary domain),
 *     and the storefront proxy redirects, same path;
 *   - can be taken back by the same store, which removes it from the list.
 *
 * The last KEEP addresses are kept; an older one is let go and free again.
 */

const KEEP = 3;

/** The workspace that used to be at `slug`, or null. */
async function ownerOf(slug, transaction) {
  const [row] = await db.sequelize.query('SELECT workspace_id FROM workspace_slug_history WHERE slug = :slug', {
    replacements: { slug },
    type: QueryTypes.SELECT,
    transaction,
  });
  return row ? row.workspace_id : null;
}

/** Another store's previous address: not for the taking. */
async function heldByOther(slug, workspaceId = null, transaction) {
  const owner = await ownerOf(slug, transaction);
  return Boolean(owner) && owner !== workspaceId;
}

/** The store moved from `oldSlug` to `newSlug`: keep the old one, give back the new one if it was an old one. */
async function retire(workspaceId, oldSlug, newSlug, transaction) {
  await db.sequelize.query('DELETE FROM workspace_slug_history WHERE slug = :newSlug AND workspace_id = :workspaceId', {
    replacements: { newSlug, workspaceId },
    transaction,
  });
  if (oldSlug && oldSlug !== newSlug) {
    await db.sequelize.query(
      `INSERT INTO workspace_slug_history (slug, workspace_id, retired_at) VALUES (:oldSlug, :workspaceId, now())
       ON CONFLICT (slug) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, retired_at = EXCLUDED.retired_at`,
      { replacements: { oldSlug, workspaceId }, transaction }
    );
  }
  await db.sequelize.query(
    `DELETE FROM workspace_slug_history
      WHERE workspace_id = :workspaceId
        AND slug NOT IN (SELECT slug FROM workspace_slug_history WHERE workspace_id = :workspaceId ORDER BY retired_at DESC LIMIT :keep)`,
    { replacements: { workspaceId, keep: KEEP }, transaction }
  );
}

/** The store's previous addresses, newest first. */
async function listFor(workspaceId) {
  return db.sequelize.query('SELECT slug, retired_at AS "retiredAt" FROM workspace_slug_history WHERE workspace_id = :workspaceId ORDER BY retired_at DESC', {
    replacements: { workspaceId },
    type: QueryTypes.SELECT,
  });
}

module.exports = { KEEP, ownerOf, heldByOther, retire, listFor };
