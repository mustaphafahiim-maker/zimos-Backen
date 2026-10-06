'use strict';

const db = require('../../db/models');
const { Op } = require('sequelize');
const { ConflictError } = require('../../core/errors/AppError');

/**
 * A generic page's address (SPEC §9.3, page settings → Details: "the link
 * using letters, digits and hyphens"). A step's key is its address —
 * /f/<funnel>/p/<key> for a generic page (genericPages.js) — and is fixed for
 * steps on the map, whose edges and sessions refer to it by key.
 *
 * A generic page has no edge, so its key may change, through the ordinary
 * step update (`key`). The keys it had before are kept in
 * `seo.previousKeys` (the five latest), so links already shared keep
 * opening the page once the funnel is published again: the public page
 * lookup falls back to them and the storefront redirects to the new address.
 */

const MAX_PREVIOUS = 5;

const previousKeysOf = (seo) => (seo && Array.isArray(seo.previousKeys) ? seo.previousKeys.filter((k) => typeof k === 'string') : []);

/**
 * The patch for moving `step` to `newKey`: `{ key, seo }`. `nextSeo` is the
 * seo the same update is writing, if any. Throws 409 when the step is on the
 * map, has a split test, or the key is taken.
 */
async function renameKey(step, newKey, { stepType, nextSeo } = {}) {
  const type = stepType || step.stepType;
  const edge = await db.FunnelEdge.findOne({
    where: { funnelId: step.funnelId, [Op.or]: [{ fromStepKey: step.key }, { toStepKey: step.key }] },
    attributes: ['id'],
  });
  if (type !== 'custom' || edge) {
    throw new ConflictError('Only a generic page can change its address — a page on the map is linked by its key', 'FUNNEL_STEP_KEY_LOCKED');
  }
  // A finished test still serves its winner on this key, so any test holds it.
  const test = await db.Experiment.findOne({ where: { funnelId: step.funnelId, stepKey: step.key }, attributes: ['id'] });
  if (test) throw new ConflictError('This page has a split test — delete it before changing its address', 'FUNNEL_STEP_KEY_LOCKED');
  const clash = await db.FunnelStep.findOne({ where: { funnelId: step.funnelId, key: newKey }, attributes: ['id'] });
  if (clash) throw new ConflictError(`A step with key "${newKey}" already exists in this funnel`, 'FUNNEL_STEP_KEY_TAKEN');

  const base = nextSeo !== undefined ? nextSeo : step.seo || {};
  const previous = [step.key, ...previousKeysOf(step.seo), ...previousKeysOf(nextSeo)].filter((k, i, all) => k !== newKey && all.indexOf(k) === i);
  return { key: newKey, seo: { ...base, previousKeys: previous.slice(0, MAX_PREVIOUS) } };
}

/** An seo write that does not mention previousKeys keeps the ones the step has. */
function keepPreviousKeys(currentSeo, nextSeo) {
  const kept = previousKeysOf(currentSeo);
  if (!nextSeo || kept.length === 0 || nextSeo.previousKeys !== undefined) return nextSeo;
  return { ...nextSeo, previousKeys: kept };
}

/** The generic page that used to be at `key`, among the published ones. */
function findMoved(pages, key) {
  return (pages || []).find((s) => previousKeysOf(s.seo).includes(key)) || null;
}

module.exports = { renameKey, keepPreviousKeys, findMoved };
