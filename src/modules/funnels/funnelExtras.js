'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { scoped } = require('../../core/utils/scopedRepository');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const entitlements = require('../billing/entitlementsService');
const { validateGraph } = require('./funnelGraph');

/**
 * What the funnel map needs beyond the core module (SPEC §9.1, §9.2):
 *
 *   share code   another merchant enters it and gets a copy of the funnel,
 *                without its products and orders;
 *   draft        the map editor's auto-saved state, kept on the server so a
 *                closed browser can offer "Load draft?" on any device;
 *   issues       everything worth fixing before (or after) publishing —
 *                fatal graph problems plus content warnings.
 *
 * Mounted on the staff funnels router by `mount()`.
 */

const SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_DRAFT_BYTES = 500 * 1024;

async function loadFunnel(workspaceId, funnelId, transaction) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, transaction });
  if (!funnel) throw new NotFoundError('Funnel');
  return funnel;
}

function newShareCode() {
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => SHARE_ALPHABET[b % SHARE_ALPHABET.length]).join('');
}

// --- share ----------------------------------------------------------------

/** The funnel's share code, created the first time it is asked for. */
async function shareFunnel(workspaceId, funnelId, req) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  if (!funnel.shareCode) {
    // The column is unique; a collision on ten random characters is retried.
    for (let attempt = 0; attempt < 5 && !funnel.shareCode; attempt += 1) {
      try {
        await funnel.update({ shareCode: newShareCode() });
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;
        funnel.shareCode = null;
      }
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'funnel.share',
      entityType: 'Funnel',
      entityId: funnel.id,
      req,
    });
  }
  return { shareCode: funnel.shareCode };
}

/** Stops the code working; a later share makes a new one. */
async function unshareFunnel(workspaceId, funnelId, req) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  if (funnel.shareCode) {
    await funnel.update({ shareCode: null });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'funnel.unshare',
      entityType: 'Funnel',
      entityId: funnel.id,
      req,
    });
  }
  return { shareCode: null };
}

/**
 * A step's page with everything that points at the source store's catalogue
 * removed: product ids in product elements and the page's own product. The
 * copy then follows the importing store's products (empty = its newest).
 */
// The author's catalogue, wherever it sits in a page: any element type, any depth (item 303).
const ID_KEYS = new Set(['productId', 'variantId', 'offerId', 'bundleId', 'collectionId']);
const ID_LIST_KEYS = new Set(['productIds', 'variantIds', 'offerIds', 'bundleIds', 'collectionIds']);

function withoutProducts(tree) {
  if (!tree || typeof tree !== 'object') return tree;
  const copy = JSON.parse(JSON.stringify(tree));
  delete copy.productId;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(node)) {
      if (ID_KEYS.has(key) && typeof node[key] === 'string') node[key] = '';
      else if (ID_LIST_KEYS.has(key) && Array.isArray(node[key])) node[key] = [];
      else walk(node[key], depth + 1);
    }
  };
  walk(copy, 0);
  return copy;
}

/**
 * A path's condition, copied into another store: the products and variants
 * its `when` names are the source store's, so the lists come over empty and
 * the issues list (and publish) asks the merchant to pick their own.
 */
function importedCondition(condition) {
  const copy = JSON.parse(JSON.stringify(condition));
  if (copy.when && typeof copy.when === 'object') {
    for (const key of ['productIds', 'variantIds']) if (Array.isArray(copy.when[key])) copy.when[key] = [];
  }
  return copy;
}

/**
 * Copies the funnel behind a share code into this workspace: its steps, their
 * pages and the links between them. Offers, order bumps, experiments, orders
 * and sessions stay with the source — an upsell step arrives without an offer
 * and the issues list says so until the merchant picks one of their own.
 */
async function importFunnel(workspaceId, { shareCode, name }, req) {
  const code = String(shareCode || '').trim().toUpperCase();
  const source = code ? await db.Funnel.findOne({ where: { shareCode: code } }) : null;
  if (!source) throw new NotFoundError('Shared funnel');

  const copyName = (name || source.name).slice(0, 200);
  return db.sequelize.transaction(async (t) => {
    const [stepRows, edgeRows] = await Promise.all([
      db.FunnelStep.findAll({ where: { funnelId: source.id }, order: [['createdAt', 'ASC']], transaction: t }),
      db.FunnelEdge.findAll({ where: { funnelId: source.id }, order: [['priority', 'DESC'], ['createdAt', 'ASC']], transaction: t }),
    ]);

    const id = crypto.randomUUID();
    // An imported funnel is a new funnel: it counts against the plan like a copy.
    await entitlements.recordFunnelCreation(workspaceId, id, 'duplicate', { transaction: t });
    const funnel = await scoped(db.Funnel, workspaceId).create(
      { id, name: copyName, subdomain: null, status: 'draft', publishedRevisionId: null },
      { transaction: t }
    );

    for (const s of stepRows) {
      await db.FunnelStep.create(
        {
          workspaceId,
          funnelId: funnel.id,
          key: s.key,
          stepType: s.stepType,
          name: s.name,
          builderData: withoutProducts(s.builderData),
          offerId: null,
          bumpOfferId: null,
          seo: s.seo ? JSON.parse(JSON.stringify(s.seo)) : {},
        },
        { transaction: t }
      );
    }
    for (const e of edgeRows) {
      await db.FunnelEdge.create(
        {
          workspaceId,
          funnelId: funnel.id,
          fromStepKey: e.fromStepKey,
          toStepKey: e.toStepKey,
          condition: e.condition ? importedCondition(e.condition) : null,
          priority: e.priority,
        },
        { transaction: t }
      );
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'funnel.import',
      entityType: 'Funnel',
      entityId: funnel.id,
      after: { name: funnel.name },
      // The source funnel's id is another store's: only the counts are kept.
      metadata: { stepCount: stepRows.length, edgeCount: edgeRows.length },
      req,
      transaction: t,
    });
    return { funnel, stepCount: stepRows.length, edgeCount: edgeRows.length };
  });
}

// --- draft ----------------------------------------------------------------

async function getDraft(workspaceId, funnelId) {
  // The one read that wants the draft itself (the model hides it by default).
  const funnel = await db.Funnel.unscoped().findOne({ where: { id: funnelId, workspaceId } });
  if (!funnel) throw new NotFoundError('Funnel');
  return { draft: funnel.draftData || null, draftUpdatedAt: funnel.draftUpdatedAt || null };
}

/** Auto-save: not audited (it fires every few seconds) and never validated as a graph — it is unfinished work. */
async function saveDraft(workspaceId, funnelId, draft) {
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > MAX_DRAFT_BYTES) {
    throw new ValidationError([{ field: 'draft', message: 'The draft is too large to auto-save' }]);
  }
  const funnel = await loadFunnel(workspaceId, funnelId);
  await funnel.update({ draftData: draft, draftUpdatedAt: new Date() });
  return { draftUpdatedAt: funnel.draftUpdatedAt };
}

async function discardDraft(workspaceId, funnelId) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  await funnel.update({ draftData: null, draftUpdatedAt: null });
  return { draft: null, draftUpdatedAt: null };
}

// --- issues ---------------------------------------------------------------

function elementsOf(tree) {
  const out = [];
  for (const section of (tree && tree.sections) || []) {
    for (const row of (section && section.rows) || []) {
      for (const column of (row && row.columns) || []) {
        for (const el of (column && column.elements) || []) if (el && typeof el === 'object') out.push(el);
      }
    }
  }
  return out;
}

const blank = (v) => typeof v !== 'string' || v.trim() === '';
const SELLING_STEPS = new Set(['sales', 'checkout']);
const PRODUCT_ELEMENTS = new Set(['product_card', 'cod_form', 'price', 'product_list']);

/**
 * Everything worth fixing in a funnel. `fatal` issues are the graph problems
 * that block publishing (funnelGraph.validateGraph, content included);
 * `warning` issues do not block it: a selling page with no product on it, a
 * button that goes nowhere, a picture with no description, an offer page with
 * no offer buttons, a store with no policies, text not translated into one of
 * the store's languages.
 */
async function listIssues(workspaceId, funnelId) {
  await loadFunnel(workspaceId, funnelId);
  const [steps, edges, workspace] = await Promise.all([
    db.FunnelStep.findAll({ where: { workspaceId, funnelId }, order: [['createdAt', 'ASC']] }),
    db.FunnelEdge.findAll({ where: { workspaceId, funnelId } }),
    db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings', 'defaultLocale'] }),
  ]);

  const issues = [];
  const graph = validateGraph(
    steps.map((s) => ({ key: s.key, stepType: s.stepType, name: s.name, offerId: s.offerId, builderData: s.builderData })),
    edges.map((e) => ({ fromStepKey: e.fromStepKey, toStepKey: e.toStepKey, condition: e.condition })),
    { requireContent: true }
  );
  for (const p of graph) {
    const match = /^steps\.([^.]+)/.exec(p.field || '');
    // An edge problem names the edge by id, not by its place in this unordered list.
    const edge = /^edges\[(\d+)\]\.(.+)$/.exec(p.field || '');
    const field = edge && edges[Number(edge[1])] ? `edges.${edges[Number(edge[1])].id}.${edge[2]}` : p.field || null;
    issues.push({ severity: 'fatal', code: 'graph', stepKey: match ? match[1] : null, field, message: p.message });
  }
  // A path's condition naming products that are not this store's (funnelRouting `when`).
  const refs = await require('./funnelRouting').whenReferenceProblems(workspaceId, edges, { fieldOf: (i) => `edges.${edges[i].id}.condition` });
  for (const p of refs) issues.push({ severity: 'fatal', code: 'graph', stepKey: null, field: p.field, message: p.message });

  for (const step of steps) {
    const elements = elementsOf(step.builderData);
    const warn = (code, message, elementId = null) =>
      issues.push({ severity: 'warning', code, stepKey: step.key, elementId, message });

    // A page sells something when it names a product itself or holds a product element.
    const pageProduct = step.builderData && typeof step.builderData.productId === 'string' && step.builderData.productId;
    if (SELLING_STEPS.has(step.stepType) && !pageProduct && !elements.some((el) => PRODUCT_ELEMENTS.has(el.type))) {
      warn('page_without_product', `"${step.name}" sells nothing yet: add a product to the page`);
    }
    for (const el of elements) {
      const props = el.props && typeof el.props === 'object' ? el.props : {};
      const bound = props.bindings && typeof props.bindings === 'object' ? props.bindings : {};
      // In a funnel a button with no link moves the shopper on, so it is only
      // unlinked when its step has nowhere to go at all.
      const hasWayOut = edges.some((e) => e.fromStepKey === step.key);
      if (el.type === 'button' && blank(props.href) && !hasWayOut) {
        warn('unlinked_button', `A button on "${step.name}" goes nowhere`, el.id);
      }
      if (el.type === 'image' && !blank(props.src) && blank(props.alt) && !bound.alt) {
        warn('image_without_alt', `An image on "${step.name}" has no description`, el.id);
      }
    }
  }

  // Texts with no translation in one of the store's languages (funnelTranslationIssues.js).
  if (workspace) issues.push(...(await require('./funnelTranslationIssues').untranslatedIssues(workspace, funnelId, steps)));

  const legal = (workspace && workspace.settings && workspace.settings.legal) || {};
  if (!require('../storefront/storeInfo').LEGAL_KEYS.some((key) => !blank(legal[key]))) {
    issues.push({
      severity: 'warning',
      code: 'missing_policies',
      stepKey: null,
      elementId: null,
      message: 'The store has no policies yet (Store settings → Policies); ad platforms ask for them',
    });
  }

  return {
    issues,
    counts: {
      fatal: issues.filter((i) => i.severity === 'fatal').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
    },
  };
}

// --- routes ---------------------------------------------------------------

const uuid = Joi.string().uuid();
const funnelParams = Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() });
const schemas = {
  one: { params: funnelParams },
  importFunnel: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      shareCode: Joi.string().trim().min(6).max(20).required(),
      name: Joi.string().trim().min(1).max(200).optional(),
    }),
  },
  saveDraft: { params: funnelParams, body: Joi.object({ draft: Joi.object().unknown(true).required() }) },
};

/**
 * Adds the routes to the staff funnels router. `MANAGE` and
 * `requireCreationAllowed` are that router's own guards, passed in so this
 * file cannot drift from them. `/import` is registered before `/:funnelId`.
 */
function mount(router, { MANAGE, requireCreationAllowed }) {
  router.post(
    '/import',
    validate(schemas.importFunnel),
    MANAGE,
    requireCreationAllowed,
    asyncHandler(async (req, res) => {
      const { funnel, stepCount, edgeCount } = await importFunnel(req.tenant.workspaceId, req.body, req);
      res.status(201).json({ funnel, stepCount, edgeCount });
    })
  );
  router.post(
    '/:funnelId/share',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await shareFunnel(req.tenant.workspaceId, req.params.funnelId, req)))
  );
  router.delete(
    '/:funnelId/share',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await unshareFunnel(req.tenant.workspaceId, req.params.funnelId, req)))
  );
  router.get(
    '/:funnelId/draft',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await getDraft(req.tenant.workspaceId, req.params.funnelId)))
  );
  router.put(
    '/:funnelId/draft',
    validate(schemas.saveDraft),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await saveDraft(req.tenant.workspaceId, req.params.funnelId, req.body.draft)))
  );
  router.delete(
    '/:funnelId/draft',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await discardDraft(req.tenant.workspaceId, req.params.funnelId)))
  );
  router.get(
    '/:funnelId/issues',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await listIssues(req.tenant.workspaceId, req.params.funnelId)))
  );
}

module.exports = { mount, shareFunnel, unshareFunnel, importFunnel, getDraft, saveDraft, discardDraft, listIssues, withoutProducts, importedCondition };
