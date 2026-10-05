'use strict';

/**
 * The `countdown` element counts down to a fixed date (SPEC §9.3 "countdown
 * (fixed date)"; §21: no timer that restarts for every visitor).
 *
 * The merchant sets `endsAt` (a date and time), or `endsInHours` — "ends N
 * hours after I publish". A duration is turned into a date once, when the page
 * or funnel is first published with it, and written back into the draft, so
 * every visitor and every later publish sees the same deadline. Templates keep
 * their durations: they are only stamped when a page made from them goes live.
 */

const MAX_HOURS = 8760;

function walk(tree, visit) {
  for (const section of (tree && Array.isArray(tree.sections) ? tree.sections : [])) {
    for (const row of section.rows || []) {
      for (const column of row.columns || []) {
        for (const element of column.elements || []) visit(element);
      }
    }
  }
}

/** A copy of the tree with each countdown's duration turned into a date; `changed` false when nothing was. */
function stampCountdowns(tree, now = new Date()) {
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.sections)) return { tree, changed: false };
  const copy = JSON.parse(JSON.stringify(tree));
  let changed = false;
  walk(copy, (element) => {
    if (!element || element.type !== 'countdown' || !element.props || typeof element.props !== 'object') return;
    const props = element.props;
    if (typeof props.endsAt === 'string' && !Number.isNaN(Date.parse(props.endsAt))) return;
    const hours = Number(props.endsInHours);
    if (!Number.isFinite(hours) || hours <= 0) return;
    props.endsAt = new Date(now.getTime() + Math.min(hours, MAX_HOURS) * 3600 * 1000).toISOString();
    changed = true;
  });
  return { tree: changed ? copy : tree, changed };
}

/** The prop rule: a date the browser can read, or "" (not set). */
const endsAtRule = (v) => (v === '' || (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))) ? null : 'must be a date and time');

module.exports = { stampCountdowns, endsAtRule };
