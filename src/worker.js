'use strict';

/**
 * The background worker (SPEC §3.1): `npm run worker`.
 *
 * Runs the outbox dispatcher, every queue processor and the repeatable jobs.
 * It serves no HTTP. Any number of workers may run side by side — jobs and
 * schedules are claimed with row locks. When a worker process runs, set
 * WORKER_IN_PROCESS=false on the API so it does only request work.
 */

const env = require('./config/env');
const db = require('./db/models');
const logger = require('./core/utils/logger');
const workerRuntime = require('./core/workerRuntime');

async function main() {
  try {
    await db.sequelize.authenticate();
    logger.info(`Worker connected to database: ${db.sequelize.config.database}`);
  } catch (err) {
    logger.error('Worker cannot connect to the database', { message: err.message });
    process.exit(1);
  }

  await workerRuntime.start();
  logger.info('Zimos worker started', { env: env.nodeEnv });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, stopping the worker`);
    setTimeout(() => process.exit(1), 15000).unref();
    await workerRuntime.stop();
    await db.sequelize.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection in worker', { reason: reason && reason.message ? reason.message : reason });
    require('./core/errors/errorReporter').report(reason, { source: 'unhandledRejection' });
  });
}

main();
