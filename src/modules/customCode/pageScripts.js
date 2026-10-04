'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Page scripts (SPEC §9.3 page settings → Scripts tab): code of the merchant's
 * own for one website page or one funnel step — in <head>, and before
 * </body>. It replaces `custom_html` in the page tree, which the tree refuses,
 * and follows the rules of the store's custom code (§8.4, customCodeService):
 *
 *   - kept outside the tree, in workspace_custom_code, one row per place:
 *     `ph:<pageId>` / `pb:<pageId>` for a page, `sh:<stepId>` / `sb:<stepId>`
 *     for a funnel step;
 *   - reading and writing need website.publish (this router sits behind the
 *     custom-code router's guard), and every save is audited;
 *   - the live store gets it with the page or step it belongs to, never in a
 *     staff preview; the storefront runs it only on the store's own host and
 *     never on the payment pages.
 *
 * Saving takes effect at once — like the store's custom code, it is not part
 * of a publish.
 */

const MAX_CODE_LENGTH = 50000;
const PREFIX = { page: { head: 'ph', body: 'pb' }, step: { head: 'sh', body: 'sb' } };

async function assertOwned(workspaceId, kind, id) {
  const model = kind === 'page' ? db.WebsitePage : db.FunnelStep;
  const row = await model.findOne({ where: { id, workspaceId }, attributes: ['id'] });
  if (!row) throw new NotFoundError(kind === 'page' ? 'Page' : 'FunnelStep');
}

async function rowsFor(workspaceId, kind, id) {
  const slots = [`${PREFIX[kind].head}:${id}`, `${PREFIX[kind].body}:${id}`];
  const rows = await db.WorkspaceCustomCode.findAll({ where: { workspaceId, slot: slots } });
  return { head: rows.find((r) => r.slot === slots[0]) || null, body: rows.find((r) => r.slot === slots[1]) || null };
}

async function getScripts(workspaceId, kind, id) {
  await assertOwned(workspaceId, kind, id);
  const { head, body } = await rowsFor(workspaceId, kind, id);
  return {
    head: head ? head.html : '',
    body: body ? body.html : '',
    isActive: Boolean((head && head.isActive) || (body && body.isActive)),
    updatedAt: [head, body].filter(Boolean).map((r) => r.updatedAt).sort().pop() || null,
  };
}

async function saveScripts(workspaceId, kind, id, { head, body, isActive }, req) {
  await assertOwned(workspaceId, kind, id);
  await db.sequelize.transaction(async (transaction) => {
    for (const [place, html] of [['head', head], ['body', body]]) {
      const slot = `${PREFIX[kind][place]}:${id}`;
      const existing = await db.WorkspaceCustomCode.findOne({ where: { workspaceId, slot }, transaction });
      const before = existing ? { html: existing.html, isActive: existing.isActive } : null;
      if (before && before.html === html && before.isActive === isActive) continue;
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
        metadata: { slot, kind, id },
        req,
        transaction,
      });
    }
  });
  return getScripts(workspaceId, kind, id);
}

/** What the live store runs on this page or step; null in a staff preview or when there is none. */
async function publicScripts(req, kind, id) {
  if (!id || req.headers['x-store-preview']) return null;
  const { head, body } = await rowsFor(req.tenant.workspaceId, kind, id);
  const live = (row) => (row && row.isActive && row.html.trim() ? row.html : '');
  const out = { head: live(head), body: live(body) };
  return out.head || out.body ? out : null;
}

const uuid = Joi.string().uuid();
const params = Joi.object({ workspaceId: uuid.required(), kind: Joi.string().valid('page', 'step').required(), id: uuid.required() });
const code = Joi.string().max(MAX_CODE_LENGTH).allow('');
const schemas = {
  get: { params },
  save: { params, body: Joi.object({ head: code.required(), body: code.required(), isActive: Joi.boolean().required() }) },
};

// Mounted inside the custom-code router: authenticate → resolveTenant → website.publish.
const router = Router({ mergeParams: true });
router.get(
  '/:kind/:id',
  validate(schemas.get),
  asyncHandler(async (req, res) => res.json({ scripts: await getScripts(req.tenant.workspaceId, req.params.kind, req.params.id) }))
);
router.put(
  '/:kind/:id',
  validate(schemas.save),
  asyncHandler(async (req, res) =>
    res.json({ scripts: await saveScripts(req.tenant.workspaceId, req.params.kind, req.params.id, req.body, req) })
  )
);

module.exports = { router, getScripts, saveScripts, publicScripts };
