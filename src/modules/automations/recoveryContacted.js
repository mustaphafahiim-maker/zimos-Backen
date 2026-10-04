'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * A recovery message that went out marks the lost order "contacted" (SPEC
 * §6.4, §6.3's follow-up column), as sending the recovery WhatsApp by hand
 * does (checkoutSessions/lostOrderWhatsapp.js). Only an order nobody has
 * dealt with yet: a merchant's own "recovered" or "lost" stays. The
 * sequence's stop check treats contacted like not contacted
 * (automationContext.loadCheckoutSubject), so the next reminder still goes.
 */
async function mark(subject) {
  if (!subject || subject.kind !== 'checkout' || !subject.session) return;
  try {
    await db.CheckoutSession.update(
      { recoveryStatus: 'contacted', contactedAt: new Date() },
      { where: { id: subject.session.id, recoveryStatus: 'not_contacted' } }
    );
  } catch (err) {
    logger.warn(`[automations] could not mark checkout ${subject.session.id} contacted: ${err.message}`);
  }
}

module.exports = { mark };
