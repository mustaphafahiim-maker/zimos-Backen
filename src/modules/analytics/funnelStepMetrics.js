'use strict';

const { Op, fn, col, literal } = require('sequelize');
const db = require('../../db/models');
const { rate } = require('./analyticsService');

/**
 * The "Page performance" numbers of a funnel's steps (SPEC §9.9), beside the
 * reach/drop-off funnelAnalyticsService already counts:
 *
 *   visits       sessions that reached the step (= `reached`)
 *   views        page views of the step from the store's own analytics
 *                events, which carry the step's key (metadata.stepKey) since
 *                the funnel runtime tags its pages
 *   movedOn      sessions that went past it (their path holds it)
 *   ctr          movedOn ÷ visits
 *   conversions  what the step is for: the order on a checkout or sales step
 *                (sessions that reached it and ordered), accepted offers on an
 *                upsell or downsell step, sign-ups on an opt-in step (moving
 *                on from it is submitting the form); null on other steps
 *   cr           conversions ÷ visits
 *   optIns       the opt-in step's sign-ups (null elsewhere)
 *
 * Rates are percentages like the rest of funnel analytics; null with no visits.
 */

const ORDER_TYPES = new Set(['checkout', 'sales']);
const OFFER_TYPES = new Set(['upsell', 'downsell']);

async function stepMetrics(workspaceId, funnelId, steps, sessions, { start, end }) {
  const createdAt = { [Op.gte]: start, [Op.lt]: end };
  const [accepted, views] = await Promise.all([
    db.FunnelOfferAcceptance.findAll({
      where: { workspaceId, funnelId, result: 'accepted', createdAt },
      attributes: ['stepKey', [fn('COUNT', col('id')), 'n']],
      group: ['stepKey'],
      raw: true,
    }),
    db.AnalyticsEvent.findAll({
      where: { workspaceId, funnelId, eventName: 'page_view', createdAt, [Op.and]: [literal("metadata->>'stepKey' IS NOT NULL")] },
      attributes: [[literal("metadata->>'stepKey'"), 'stepKey'], [fn('COUNT', col('id')), 'n']],
      group: [literal("metadata->>'stepKey'")],
      raw: true,
    }),
  ]);
  const acceptedBy = new Map(accepted.map((r) => [r.stepKey, Number(r.n)]));
  const viewsBy = new Map(views.map((r) => [r.stepKey, Number(r.n)]));

  const out = new Map();
  for (const step of steps) {
    let visits = 0;
    let movedOn = 0;
    let ordered = 0;
    for (const s of sessions) {
      const passed = (s.path || []).includes(step.key);
      if (!passed && s.currentStepKey !== step.key) continue;
      visits += 1;
      if (passed) movedOn += 1;
      if (s.orderId) ordered += 1;
    }
    let conversions = null;
    if (ORDER_TYPES.has(step.stepType)) conversions = ordered;
    else if (OFFER_TYPES.has(step.stepType)) conversions = acceptedBy.get(step.key) || 0;
    else if (step.stepType === 'opt_in') conversions = movedOn;
    out.set(step.key, {
      visits,
      views: viewsBy.get(step.key) || 0,
      movedOn,
      ctr: rate(movedOn, visits),
      conversions,
      cr: conversions === null ? null : rate(conversions, visits),
      optIns: step.stepType === 'opt_in' ? movedOn : null,
    });
  }
  return out;
}

module.exports = { stepMetrics };
