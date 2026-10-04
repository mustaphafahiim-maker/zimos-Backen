'use strict';

const quickReply = require('./quickReplyConfirmation');
const bot = require('./bot/botService');

/** Background work of the WhatsApp module (core/queue finds this file by its name). */
module.exports = {
  // A customer's tap on "Confirm order" / "Cancel" confirms or cancels the order.
  processors: [
    { queue: 'notifications', name: quickReply.JOB, handle: (job) => quickReply.process(job) },
    // The customer service bot's answer to a customer's message (bot/botService.js).
    { queue: 'ai', name: bot.JOB, handle: (job) => bot.process(job) },
  ],
};
