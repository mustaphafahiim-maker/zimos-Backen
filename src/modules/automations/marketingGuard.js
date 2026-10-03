'use strict';

const db = require('../../db/models');
const { normalizePhone } = require('../../core/utils/phone');

/**
 * Marketing messages (SPEC §6.4): abandoned-checkout recovery, the review
 * request and messages to a new lead are not about an order the customer is
 * waiting on, so they are never sent to a phone that answered STOP
 * (marketing_opt_outs) or that the store blocked (blocked_entries, or a
 * blacklisted customer). Order updates — confirmation, shipping, delivery —
 * still go out: the customer asked for those by ordering.
 */
const MARKETING_TRIGGERS = new Set(['checkout.abandoned', 'lost_order.created', 'review.request', 'lead.created']);

const isMarketing = (trigger) => MARKETING_TRIGGERS.has(trigger);

/** Null when the message may go out; otherwise why it may not. */
async function refusal(workspaceId, phone) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;
  if (await db.MarketingOptOut.count({ where: { workspaceId, phoneNormalized } })) return 'the customer replied STOP to marketing messages';
  if (await db.BlockedEntry.count({ where: { workspaceId, type: 'phone', value: phoneNormalized } })) return 'the phone number is blocked';
  if (await db.Customer.count({ where: { workspaceId, phoneNormalized, isBlacklisted: true } })) return 'the customer is blacklisted';
  return null;
}

module.exports = { MARKETING_TRIGGERS, isMarketing, refusal };
