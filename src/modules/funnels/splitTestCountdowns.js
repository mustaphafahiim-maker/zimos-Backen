'use strict';

const db = require('../../db/models');
const { stampCountdowns } = require('../pages/countdownDeadline');

/**
 * A split test's variant pages count down to a fixed date like every live
 * page (pages/countdownDeadline.js; SPEC §9.3, §21). A variant goes live when
 * its test runs on a published funnel. Its countdown's "N hours" becomes a
 * date then: when the test is created or changed on a live funnel, or when
 * the funnel is published with the test running. The control (variant A) is
 * the step's own page, stamped by the funnel's publish.
 */

/** The variants with each page's countdown durations turned into dates; `changed` false when none were. */
function stampVariants(variants, now = new Date()) {
  let changed = false;
  const next = (variants || []).map((variant) => {
    const tree = variant && variant.data && variant.data.builderData;
    if (!tree) return variant;
    const stamped = stampCountdowns(tree, now);
    if (!stamped.changed) return variant;
    changed = true;
    return { ...variant, data: { ...variant.data, builderData: stamped.tree } };
  });
  return { variants: next, changed };
}

/** For a test being saved: stamped when its funnel is live, untouched on a draft funnel. */
async function forSave(workspaceId, funnelId, variants, transaction) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['status'], transaction });
  return funnel && funnel.status === 'published' ? stampVariants(variants).variants : variants;
}

/**
 * At the funnel's publish: the running and paused tests on it. Their pages'
 * linked saved sections are filled in too, as the steps' are: a variant page
 * is both what the editor holds and what visitors see, and keeps its links.
 */
async function stampRunning(workspaceId, funnelId, transaction) {
  const { resolveLinkedSections } = require('../savedSections/savedSectionsService');
  const tests = await db.Experiment.findAll({
    where: { workspaceId, funnelId, subjectType: 'funnel_step', status: ['running', 'paused'] },
    transaction,
  });
  for (const test of tests) {
    const linked = [];
    for (const variant of test.variants || []) {
      const tree = variant && variant.data && variant.data.builderData;
      linked.push(tree ? { ...variant, data: { ...variant.data, builderData: await resolveLinkedSections(workspaceId, tree, { transaction, stampCountdowns: true, funnelId }) } } : variant);
    }
    const { variants } = stampVariants(linked);
    if (JSON.stringify(variants) !== JSON.stringify(test.variants)) await test.update({ variants }, { transaction });
  }
}

module.exports = { stampVariants, forSave, stampRunning };
