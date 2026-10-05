'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AuthorizationError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const { scoped } = require('../../core/utils/scopedRepository');
const { recordAudit } = require('../audit/auditService');
const entitlements = require('../billing/entitlementsService');
const { validateStepData } = require('../funnels/funnelGraph');

/**
 * A generated landing page (feature `page`) turned into a draft funnel
 * (SPEC §19 "Funnel/landing with AI", §9.1 "AI template"): the page as the
 * sales step, then a checkout with the cash on delivery form and a thank-you
 * page — sales → checkout (always) → thank you (completed checkout).
 *
 * Built in one transaction like an imported funnel, counted against the
 * plan's funnels, and left as a draft: nothing the AI wrote goes live
 * without the merchant (SPEC §19). Buttons in the generated page that pointed
 * at the product page now carry the shopper to the next step instead.
 */

const pos = (order) => ({ zimosCanvas: { x: 80 + order * 320, y: 120, order } });
let seq = 0;
const id = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;

const tree = (elements) => ({
  version: 1,
  sections: [{ id: id('s'), type: 'section', rows: [{ id: id('r'), type: 'row', columns: [{ id: id('c'), type: 'column', span: 12, elements }] }] }],
});

function checkoutTree(productId, ar) {
  return tree([
    { id: id('e'), type: 'heading', props: { text: ar ? 'أكمل طلبك' : 'Complete your order' } },
    { id: id('e'), type: 'cod_form', props: { title: ar ? 'بيانات التوصيل' : 'Delivery details', productId } },
    { id: id('e'), type: 'checkout_summary', props: { title: ar ? 'ملخص الطلب' : 'Order summary' } },
  ]);
}

function thankYouTree(ar) {
  return tree([
    { id: id('e'), type: 'heading', props: { text: ar ? 'شكرًا لطلبك!' : 'Thank you for your order!' } },
    { id: id('e'), type: 'text', props: { text: ar ? 'هنتواصل معاك قريب لتأكيد الطلب.' : 'We will contact you shortly to confirm your order.' } },
    { id: id('e'), type: 'order_summary', props: { title: ar ? 'تفاصيل الطلب' : 'Order details' } },
  ]);
}

/** The generated page with its product-page links pointing at the next step instead (an empty href). */
function salesTree(output, productId) {
  const copy = JSON.parse(JSON.stringify(output.tree));
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && node.props && typeof node.props.href === 'string' && node.props.href.startsWith('/products/')) {
      delete node.props.href;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(copy);
  return { ...copy, productId };
}

async function applyAsFunnel(workspaceId, job, { name, subdomain } = {}, req) {
  if (!req.tenant.hasPermission(PERMISSIONS.FUNNELS_MANAGE)) {
    throw new AuthorizationError('You need permission to manage funnels to create one');
  }
  const productId = job.input.productId;
  const ar = job.input.dialect !== 'english' && job.input.dialect !== 'french';
  const steps = [
    { key: 'sales', stepType: 'sales', name: ar ? 'صفحة البيع' : 'Sales page', builderData: salesTree(job.output, productId) },
    { key: 'checkout', stepType: 'checkout', name: ar ? 'إتمام الطلب' : 'Checkout', builderData: { ...checkoutTree(productId, ar), productId } },
    { key: 'thanks', stepType: 'thank_you', name: ar ? 'شكرًا' : 'Thank you', builderData: { ...thankYouTree(ar), productId } },
  ];
  for (const s of steps) validateStepData(s.builderData);
  const edges = [
    { fromStepKey: 'sales', toStepKey: 'checkout', condition: { type: 'always' }, priority: 0 },
    { fromStepKey: 'checkout', toStepKey: 'thanks', condition: { type: 'completed_checkout' }, priority: 0 },
  ];

  return db.sequelize.transaction(async (transaction) => {
    const funnelId = crypto.randomUUID();
    await entitlements.recordFunnelCreation(workspaceId, funnelId, 'create', { transaction });
    const funnelName = String(name || job.output.title || 'AI funnel').slice(0, 200);
    // Its link, as createFunnel gives one: the one asked for, else from the name, made unique.
    // eslint-disable-next-line global-require
    const link = await require('../funnels/funnelsService').ensureUniqueSubdomain(subdomain || funnelName);
    const funnel = await scoped(db.Funnel, workspaceId).create(
      { id: funnelId, name: funnelName, subdomain: link, status: 'draft', publishedRevisionId: null },
      { transaction }
    );
    for (const [order, s] of steps.entries()) {
      await db.FunnelStep.create({ workspaceId, funnelId, ...s, offerId: null, bumpOfferId: null, seo: pos(order) }, { transaction });
    }
    for (const e of edges) await db.FunnelEdge.create({ workspaceId, funnelId, ...e }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'funnel.create',
      entityType: 'Funnel',
      entityId: funnel.id,
      after: { name: funnel.name },
      metadata: { fromAiJob: job.id, stepCount: steps.length },
      req,
      transaction,
    });
    return { type: 'funnel', id: funnel.id };
  });
}

module.exports = { applyAsFunnel };
