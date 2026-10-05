'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { STATS_CTE } = require('../contacts/segmentRules');

/**
 * Segments in automations (SPEC §18.4 "used by automations"): a rule may run
 * only for contacts in a segment (`conditions.segmentId`) and/or skip those
 * in another (`conditions.excludeSegmentId`). The segment is evaluated at the
 * moment the rule starts, against the live orders, like everywhere else.
 *
 * Works for every subject that names a contact: an order's customer, a lost
 * checkout's (by its phone), a lead, a subscription's customer.
 */

// The per-contact stats, worked out for this one contact only.
const ONE_CONTACT_CTE = STATS_CTE.replace('WHERE o.workspace_id = :workspaceId', 'WHERE o.workspace_id = :workspaceId AND o.customer_id = :contactId');

async function contactOf(subject) {
  if (subject.kind === 'order') return subject.order.customerId || null;
  if (subject.kind === 'customer') return subject.customer ? subject.customer.id : null;
  if (subject.kind === 'checkout') {
    const { session } = subject;
    if (session.customerId) return session.customerId;
    if (!session.phoneNormalized) return null;
    const found = await db.Customer.findOne({ where: { workspaceId: session.workspaceId, phoneNormalized: session.phoneNormalized }, attributes: ['id'] });
    return found ? found.id : null;
  }
  return null;
}

/** True / false, or null when the segment no longer exists. */
async function inSegment(workspaceId, segmentId, contactId) {
  let filter;
  try {
    filter = await require('../contacts/contactService').buildFilter(workspaceId, { segmentId });
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
  const rows = await db.sequelize.query(
    `WITH ${ONE_CONTACT_CTE}
     SELECT 1 FROM customers c LEFT JOIN stats s ON s.customer_id = c.id
      WHERE ${filter.where} AND c.id = :contactId LIMIT 1`,
    { replacements: { ...filter.replacements, contactId }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

/** Why the rule is skipped for this subject, or null when the segment conditions hold. */
async function segmentFails(conditions, subject, workspaceId) {
  const include = conditions.segmentId || null;
  const exclude = conditions.excludeSegmentId || null;
  if (!include && !exclude) return null;
  const contactId = await contactOf(subject);
  if (!contactId) return include ? 'no contact to check against the segment' : null;
  if (include) {
    const hit = await inSegment(workspaceId, include, contactId);
    if (hit === null) return 'the segment was deleted';
    if (!hit) return 'contact is not in the segment';
  }
  if (exclude && (await inSegment(workspaceId, exclude, contactId))) return 'contact is in the excluded segment';
  return null;
}

module.exports = { segmentFails, inSegment };
