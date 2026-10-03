'use strict';

/**
 * One reconciliation run for online subscription payments, then exit. Meant
 * for a Railway cron service (every 5 minutes) running this same image:
 *
 *   node scripts/sweep-billing-payments.js
 *
 * What it does (modules/billing/onlineBillingService.js, `sweep`):
 *   - processes again any verified Fawaterak webhook whose processing failed
 *   - marks a checkout that was never received as an error
 *   - asks Fawaterak (getTransactionData) about every attempt that could
 *     still be paid, often while young and less often as it ages, and settles
 *     the charge of one that was — the same path as a webhook
 *
 * Separate from scripts/sweep-payments.js, which is the stores' own gateways.
 * It never starts a web server and never runs migrations. Exits 0 when the
 * run finished (whatever it found), 1 when it could not run at all. With the
 * FAWATERAK_* keys unset it does nothing and says so.
 *
 * SWEEP_BATCH_SIZE (default 50) caps each step.
 */

const db = require('../src/db/models');
const logger = require('../src/core/utils/logger');
const { sweep } = require('../src/modules/billing/onlineBillingService');

async function main() {
  const limit = Math.max(1, parseInt(process.env.SWEEP_BATCH_SIZE || '50', 10) || 50);
  const started = Date.now();
  const result = await sweep({ limit });
  logger.info('Billing payments sweep finished', { ms: Date.now() - started, ...result });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    logger.error('Billing payments sweep failed', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (err) {
      // Already closed or never opened; the exit code says what happened.
    }
  });
