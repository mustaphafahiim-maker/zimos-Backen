'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { recordAudit } = require('../audit/auditService');

/*
 * Custom HTML blocks (SPEC §8.2 "HTML code", §8.4): HTML of the merchant's own
 * at a place of their choosing in a website page or a funnel step.
 *
 * The page tree only holds an `html_block` element with a `blockId` (it
 * refuses markup, pages/pageTree.js); the HTML is kept here, outside the tree,
 * in workspace_custom_code under the slot `hb:<blockId>`, under the rules of
 * the store's custom code (customCodeService.js):
 *
 *   - reading and writing need website.publish (this router sits behind the
 *     custom-code router's guard), and every save is audited with the code
 *     before and after;
 *   - the live store gets the blocks with the page or step that places them
 *     (`htmlBlocks`: { blockId: html }), never in a staff preview; the
 *     storefront runs them only on the store's own host and never on the
 *     payment pages.
 *
 * Like page scripts, saving takes effect at once rather than with a publish.
 * A block whose element was removed from every page is simply never served.
 *
 *   GET /workspaces/:id/custom-code/html-blocks/:blockId
 *   PUT /workspaces/:id/custom-code/html-blocks/:blockId   { html, isActive }
 */

const MAX_CODE_LENGTH = 50000;
const slotOf = (blockId) => `hb:${blockId}`;
const BLOCK_ID = /^[a-z0-9]{8,24}$/;

const present = (row, blockId) => ({ blockId, html: row ? row.html : '', isActive: row ? row.isActive : true, updatedAt: row ? row.updatedAt : null });

async function getBlock(workspaceId, blockId) {
  const row = await db.WorkspaceCustomCode.findOne({ where: { workspaceId, slot: slotOf(blockId) } });
  return present(row, blockId);
}

async function saveBlock(workspaceId, blockId, { html, isActive }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const slot = slotOf(blockId);
    const existing = await db.WorkspaceCustomCode.findOne({ where: { workspaceId, slot }, transaction, lock: transaction.LOCK.UPDATE });
    const before = existing ? { html: existing.html, isActive: existing.isActive } : null;
    const values = { html, isActive, updatedBy: req.user.id };
    const row = existing ? await existing.update(values, { transaction }) : await db.WorkspaceCustomCode.create({ workspaceId, slot, ...values }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'custom_code.html_block_update',
      entityType: 'WorkspaceCustomCode',
      entityId: row.id,
      before,
      after: { html, isActive },
      metadata: { blockId },
      req,
      transaction,
    });
    return present(row, blockId);
  });
}

/** Every html_block id in a page tree or funnel step tree (any shape of nested children). */
function blockIdsIn(tree) {
  const ids = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'html_block' && node.props && BLOCK_ID.test(String(node.props.blockId || ''))) ids.add(node.props.blockId);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(tree);
  return [...ids];
}

/** What the live store runs for the blocks a tree places: { blockId: html }; null in a staff preview or when there is none. */
async function publicBlocks(req, tree) {
  if (req.headers['x-store-preview']) return null;
  const ids = blockIdsIn(tree);
  if (ids.length === 0) return null;
  const rows = await db.WorkspaceCustomCode.findAll({
    where: { workspaceId: req.tenant.workspaceId, slot: ids.map(slotOf), isActive: true },
    attributes: ['slot', 'html'],
  });
  const out = {};
  for (const row of rows) if (row.html.trim()) out[row.slot.slice(3)] = row.html;
  return Object.keys(out).length ? out : null;
}

const params = Joi.object({ workspaceId: Joi.string().uuid().required(), blockId: Joi.string().pattern(BLOCK_ID).required() });
const schemas = {
  get: { params },
  save: { params, body: Joi.object({ html: Joi.string().max(MAX_CODE_LENGTH).allow('').required(), isActive: Joi.boolean().required() }) },
};

// Mounted inside the custom-code router: authenticate → resolveTenant → website.publish.
const router = Router({ mergeParams: true });
router.get('/:blockId', validate(schemas.get), asyncHandler(async (req, res) => res.json({ block: await getBlock(req.tenant.workspaceId, req.params.blockId) })));
router.put(
  '/:blockId',
  validate(schemas.save),
  asyncHandler(async (req, res) => res.json({ block: await saveBlock(req.tenant.workspaceId, req.params.blockId, req.body, req) }))
);

module.exports = { router, getBlock, saveBlock, blockIdsIn, publicBlocks };
