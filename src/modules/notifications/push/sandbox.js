'use strict';

/**
 * The sandbox push provider: nothing leaves the server. Each push is written
 * to the notification log (channel `push`, provider `sandbox`) so a developer
 * — or the merchant on a test server — can see what would have been sent.
 * A device registers with any token (`sandbox:…` from the dashboard).
 */
const db = require('../../../db/models');

const name = 'sandbox';

async function send(device, message) {
  await db.NotificationLog.create({
    workspaceId: message.workspaceId || null,
    channel: 'push',
    provider: name,
    recipient: `${device.platform}:${device.id}`,
    template: message.type || 'push',
    status: 'sent',
    error: null,
    attempts: 1,
    // A shopper's order push: listed on the order's timeline.
    orderId: message.orderId || null,
    subject: message.orderId && message.title ? String(message.title).slice(0, 300) : null,
  });
  return { status: 'sent' };
}

module.exports = { name, send, publicKey: () => null };
