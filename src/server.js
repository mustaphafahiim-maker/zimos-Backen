'use strict';

const app = require('./app');
const env = require('./config/env');
const db = require('./db/models');
const logger = require('./core/utils/logger');
const { describeStorage, r2ConfigError } = require('./modules/media/storage');
const { logRollout: logCarrierRollout } = require('./modules/shipping/carriers');
const { imageProcessingStatus } = require('./modules/media/imageProcessing');
const signupPolicy = require('./modules/auth/signupPolicy');
const { releaseDraftsWhenOff } = require('./modules/billing/goLiveService');
const webhookWorker = require('./modules/webhooks/webhookWorker');
const workerRuntime = require('./core/workerRuntime');

async function start() {
  try {
    await db.sequelize.authenticate();
    // Report the database this process is actually on — queried live, not
    // read from .env — so it's obvious at a glance on every boot.
    const [rows] = await db.sequelize.query('SELECT current_database() AS name');
    const liveName = rows[0].name;
    const { host, port } = db.sequelize.config;
    logger.info(`Connected to database: ${liveName} (${host}:${port})`);
  } catch (err) {
    logger.error('Unable to connect to the database', { message: err.message });
    process.exit(1);
  }

  // Same idea for image storage: print what STORAGE_PROVIDER actually
  // resolved to in THIS process, so a deploy log settles "is it on R2?".
  logger.info(`Storage backend: ${describeStorage()}`);
  const storageProblem = r2ConfigError();
  if (storageProblem) logger.error(`Storage misconfigured: ${storageProblem} — uploads will fail until this is fixed`);

  // Image processing (sharp): every upload is re-encoded and stripped of its
  // metadata, so a missing native binary must be visible at boot.
  logger.info(`Image processing: ${imageProcessingStatus()}`);

  // The upload sweep, ads.sync_spend and fx.update_rates are queue schedules
  // (each module's jobs.js), run once by the worker, not a timer per process.

  // And for couriers: which adapters this process actually switched on, from
  // CARRIERS_ENABLED / CARRIERS_BETA / CARRIERS_BETA_WORKSPACES as parsed.
  await logCarrierRollout(logger);

  // Sign-up and go-live switches (REQUIRE_*), and a verification switch with
  // no email provider behind it (sign-ups are refused until one is set).
  signupPolicy.logBootState(logger);
  // Public endpoints that can be closed, and the reset link's base (item 331);
  // the phone change by SMS code in the account settings (item 332).
  logger.info(
    `Public switches: shopper review form ${env.reviews.publicSubmissionEnabled ? 'open' : 'closed'}, password reset by SMS ${
      env.passwordReset.smsEnabled ? 'on' : 'off'
    }, phone change by SMS ${env.account.phoneChangeEnabled ? 'on' : 'off'}, marketing-site traffic ${env.siteAnalytics.enabled ? 'on' : 'off'}`
  );
  // Item 339: on with no origin listed refuses every beacon (403).
  if (env.siteAnalytics.enabled && env.siteAnalytics.origins.length === 0) {
    logger.warn('SITE_ANALYTICS_ENABLED is on but SITE_ANALYTICS_ORIGINS is empty: every site event is refused (403 ORIGIN_NOT_ALLOWED)');
  }
  if (env.isProduction && !env.frontendUrlConfigured) {
    logger.error('FRONTEND_URL is not set: password reset requests are refused (503 PASSWORD_RESET_UNAVAILABLE) until it is');
  }
  // With REQUIRE_SUBSCRIPTION_TO_GO_LIVE off, drafts left from while it was
  // on become the trials they would have been.
  try {
    const released = await releaseDraftsWhenOff();
    if (released > 0) logger.info(`Released ${released} draft store(s): REQUIRE_SUBSCRIPTION_TO_GO_LIVE is off`);
  } catch (err) {
    logger.error('Could not release draft stores', { message: err.message });
  }

  const server = app.listen(env.port, () => {
    logger.info(`Zimos backend listening on port ${env.port}`, { env: env.nodeEnv });
  });

  // Outbound webhooks: find order changes and send them, every few seconds
  // (WEBHOOKS_IN_PROCESS=false leaves it to scripts/dispatch-webhooks.js).
  if (env.webhooks.inProcess) webhookWorker.start();

  // Background jobs and domain events (core/queue, core/outbox): run here
  // unless a separate worker does (WORKER_IN_PROCESS=false + npm run worker).
  if (env.queue.inProcess) {
    workerRuntime.start().catch((err) => logger.error('Could not start the in-process worker', { message: err.message }));
  }

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    webhookWorker.stop();
    server.close(async () => {
      // Reset emails already answered for go out before the database closes.
      await require('./modules/auth/authService').settlePasswordResets();
      // And account codes already answered for (item 332).
      await require('./modules/otp/verificationCodeService').settleAccountCodeDeliveries();
      await workerRuntime.stop();
      await db.sequelize.close();
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason && reason.message ? reason.message : reason });
    require('./core/errors/errorReporter').report(reason, { source: 'unhandledRejection' });
  });
}

start();
