'use strict';

const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');

/**
 * The console provider's delivery reports (item 386), for trying the feature
 * without Brevo or Twilio. Only with NOTIFICATION_STATUS_SIMULATION=true and
 * never in production. A moment after a console send, the report a real
 * provider would send is applied through the same code as the webhooks
 * (providerEvents.js), matched to the console message only:
 *
 *   email  name+bounce@…     hard bounce (the address is suppressed)
 *          name+complaint@…  spam complaint (suppressed)
 *          name+softbounce@… soft bounce (noted, nothing else)
 *          name+blocked@…    undelivered
 *          anything else     delivered
 *   SMS    a number ending in 0000 → undelivered (error 30003); else delivered
 */

const DELAY_MS = 1500;

function emailEvent(recipient) {
  const local = String(recipient || '').split('@')[0].toLowerCase();
  const tag = local.includes('+') ? local.slice(local.lastIndexOf('+') + 1) : '';
  return { bounce: 'hard_bounce', complaint: 'spam', softbounce: 'soft_bounce', blocked: 'blocked' }[tag] || 'delivered';
}

function later(fn) {
  const t = setTimeout(() => {
    Promise.resolve()
      .then(fn)
      .catch((err) => logger.error(`[deliveryStatus:simulate] ${err.message}`));
  }, DELAY_MS);
  if (t.unref) t.unref();
}

/** After a console send: schedules its simulated report (no-op when simulation is off). */
function afterConsoleSend({ channel, recipient, messageId }) {
  if (!env.notifications.simulateStatus || env.isProduction || !messageId) return;
  const events = require('./providerEvents');
  const opts = { providers: ['console'], source: 'console' };
  if (channel === 'email') {
    const event = emailEvent(recipient);
    later(() => events.brevoEvent({ event, email: recipient, 'message-id': messageId, reason: event === 'delivered' ? undefined : 'simulated' }, opts));
  } else if (channel === 'sms') {
    const bad = /0000$/.test(String(recipient).replace(/\D/g, ''));
    later(() => events.twilioStatus({ MessageSid: messageId, MessageStatus: bad ? 'undelivered' : 'delivered', ErrorCode: bad ? '30003' : undefined }, opts));
  }
}

module.exports = { afterConsoleSend, emailEvent };
