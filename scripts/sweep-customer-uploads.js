'use strict';

/**
 * Deletes shoppers' photos that no order took before they expired
 * (CUSTOMER_UPLOAD_TTL_HOURS, 48 by default) — from storage, then from the
 * customer_uploads table. The API already does this every
 * CUSTOMER_UPLOAD_SWEEP_MINUTES (30); this is the same sweep, by hand or from
 * a scheduler, e.g. when the in-process one is switched off (0).
 *
 *   node scripts/sweep-customer-uploads.js
 *
 * Safe to run alongside the API: sweeps never overlap (advisory lock), and a
 * photo an order is attaching right now is skipped.
 */

const db = require('../src/db/models');
const { sweepExpiredUploads } = require('../src/modules/customerUploads/customerUploadService');

sweepExpiredUploads()
  .then((removed) => console.log(`[sweep-customer-uploads] removed ${removed} expired photo(s)`))
  .catch((err) => {
    console.error(`[sweep-customer-uploads] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
