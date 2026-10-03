'use strict';

const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { recordAudit } = require('../audit/auditService');

/**
 * Code customizations (SPEC §8.4): fixed slots of the store where a merchant
 * places code of their own.
 *
 *   UI blocks (HTML):  above_header, below_header, above_gallery,
 *                      below_gallery, above_form, below_form, above_footer,
 *                      below_footer
 *   head               injected into <head> (external tracking tools)
 *   css / js           "design files": a stylesheet and a script loaded on
 *                      every store page
 *
 * Security decisions, all enforced here or by the storefront:
 *   - the code lives in its own table, never in the page tree (which refuses
 *     raw HTML), and every edit is written to the audit log with who made it;
 *   - writing needs website.publish — the same bar as putting a site live;
 *   - the public read returns nothing to a staff preview (a preview carries a
 *     token) and the storefront injects code only on the store's own host,
 *     never on the shared platform host, in the dashboard, or on the card
 *     payment pages.
 */

const SLOTS = Object.freeze([
  'above_header',
  'below_header',
  'above_gallery',
  'below_gallery',
  'above_form',
  'below_form',
  'above_footer',
  'below_footer',
  'head',
  'css',
  'js',
]);

const MAX_CODE_LENGTH = 50000;

const present = (row, slot) => ({
  slot,
  html: row ? row.html : '',
  isActive: row ? row.isActive : false,
  updatedAt: row ? row.updatedAt : null,
  updatedBy: row ? row.updatedBy : null,
});

/** Every slot, filled or not, in the fixed order — what the dashboard edits. */
async function listSlots(workspaceId) {
  const rows = await scoped(db.WorkspaceCustomCode, workspaceId).findAll();
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  return SLOTS.map((slot) => present(bySlot.get(slot), slot));
}

/** Creates or replaces one slot. Audited with the code before and after. */
async function saveSlot(workspaceId, slot, { html, isActive }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const existing = await db.WorkspaceCustomCode.findOne({ where: { workspaceId, slot }, transaction });
    const before = existing ? { html: existing.html, isActive: existing.isActive } : null;
    const values = { html, isActive, updatedBy: req.user.id };
    const row = existing
      ? await existing.update(values, { transaction })
      : await db.WorkspaceCustomCode.create({ workspaceId, slot, ...values }, { transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'custom_code.update',
      entityType: 'WorkspaceCustomCode',
      entityId: row.id,
      before,
      after: { html: row.html, isActive: row.isActive },
      metadata: { slot },
      req,
      transaction,
    });
    return present(row, slot);
  });
}

/** The active, non-empty slots as { slot: code } — what a live store loads. */
async function publicSlots(workspaceId) {
  const rows = await db.WorkspaceCustomCode.findAll({
    where: { workspaceId, isActive: true },
    attributes: ['slot', 'html'],
  });
  const out = {};
  for (const row of rows) {
    if (SLOTS.includes(row.slot) && row.html.trim() !== '') out[row.slot] = row.html;
  }
  return out;
}

module.exports = { CUSTOM_CODE_SLOTS: SLOTS, MAX_CODE_LENGTH, listSlots, saveSlot, publicSlots };
