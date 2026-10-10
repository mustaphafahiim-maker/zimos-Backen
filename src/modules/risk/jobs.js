'use strict';

module.exports = {
  processors: [
    {
      // The AI text check of one moderate-risk order (risk/aiOrderCheck). The
      // `ai` queue tries twice; a failure leaves the order's score as it was.
      queue: 'ai',
      name: 'risk.ai_order_check',
      // eslint-disable-next-line global-require
      handle: (job) => require('./aiOrderCheck').run(job.payload.orderId, job.workspaceId),
    },
  ],
};
