'use strict';

const quickReply = require('./quickReplyConfirmation');

/** Background work of the WhatsApp module (core/queue finds this file by its name). */
module.exports = {
  // A customer's tap on "Confirm order" / "Cancel" confirms or cancels the order.
  processors: [{ queue: 'notifications', name: quickReply.JOB, handle: (job) => quickReply.process(job) }],
};
