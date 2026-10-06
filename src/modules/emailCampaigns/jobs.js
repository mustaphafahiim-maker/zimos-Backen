'use strict';

/** Email campaigns (campaignService.js): one batch at a time, and the scheduled ones started when due. */
// eslint-disable-next-line global-require
const svc = () => require('./campaignService');

module.exports = {
  processors: [{ queue: 'notifications', name: 'email_campaigns.send_batch', handle: (job) => svc().sendBatch(job.payload.campaignId) }],
  schedules: [{ name: 'email_campaigns.start_due', everyMs: 60 * 1000, handle: () => svc().startDue() }],
};
