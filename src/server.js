'use strict';

const app = require('./app');
const env = require('./config/env');
const db = require('./db/models');
const logger = require('./core/utils/logger');
const { describeStorage, r2ConfigError } = require('./modules/media/storage');
const { logRollout: logCarrierRollout } = require('./modules/shipping/carriers');
const { imageProcessingStatus } = require('./modules/media/imageProcessing');
const { startUploadSweep } = require('./modules/customerUploads/customerUploadService');
const { startAdsSync } = require('./modules/profit/adsSyncJob');
const signupPolicy = require('./modules/auth/signupPolicy');
const { releaseDraftsWhenOff } = require('./modules/billing/goLiveService');
const webhookWorker = require('./modules/webhooks/webhookWorker');

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

  // Shoppers' photos no order took are deleted after CUSTOMER_UPLOAD_TTL_HOURS.
  startUploadSweep();

  // ads.sync_spend: hourly pull of ad spend from connected ad accounts.
  startAdsSync();

  // And for couriers: which adapters this process actually switched on, from
  // CARRIERS_ENABLED / CARRIERS_BETA / CARRIERS_BETA_WORKSPACES as parsed.
  await logCarrierRollout(logger);

  // Sign-up and go-live switches (REQUIRE_*), and a verification switch with
  // no email provider behind it (sign-ups are refused until one is set).
  signupPolicy.logBootState(logger);
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

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    webhookWorker.stop();
    server.close(async () => {
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
  });
}

start();
