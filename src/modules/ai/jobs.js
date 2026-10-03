'use strict';

module.exports = {
  processors: [
    {
      // One AI generation (aiService.runJob). The `ai` queue tries twice; the
      // job row records the failure when the second attempt fails too.
      queue: 'ai',
      name: 'ai.generate',
      handle: (job) =>
        // eslint-disable-next-line global-require
        require('./aiService').runJob(job.payload.jobId, { lastAttempt: job.attempts >= job.maxAttempts }),
    },
  ],
};
