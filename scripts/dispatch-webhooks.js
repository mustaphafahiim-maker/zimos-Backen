'use strict';

/**
 * One webhook pass, then exit — for a cron service running this same image,
 * the way scripts/sync-carrier-shipments.js runs:
 *
 *   node scripts/dispatch-webhooks.js
 *
 * The API process already runs this every WEBHOOKS_INTERVAL_MS (5 s) unless
 * WEBHOOKS_IN_PROCESS=false; the script is for deployments that turn that
 * off, or want a second runner. What one pass does
 * (modules/webhooks/webhookWorker.js#runOnce):
 *
 *   - reads the orders and shipments that changed since the last pass and
 *     queues an event for each order whose state moved, for every store
 *     endpoint subscribed to it (orderChangeDetector.js)
 *   - sends every delivery that is due, and schedules a retry — with growing
 *     gaps, eight attempts over about two days — for each one the receiver
 *     didn't accept (webhookDispatcher.js)
 *
 * Both steps lock what they work on (FOR UPDATE SKIP LOCKED), so overlapping
 * runs never send a delivery twice. It never starts a web server and never
 * runs migrations. Exits 0 when the pass finished, 1 when it could not run.
 */

const db = require('../src/db/models');
const logger = require('../src/core/utils/logger');
const { runOnce } = require('../src/modules/webhooks/webhookWorker');

async function main() {
  const started = Date.now();
  const result = await runOnce();
  logger.info('Webhook dispatch finished', { ms: Date.now() - started, ...result });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    logger.error('Webhook dispatch failed', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (err) {
      // Already closed or never opened; the exit code says what happened.
    }
  });
