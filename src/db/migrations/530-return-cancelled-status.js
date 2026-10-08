'use strict';

/**
 * A return request can be cancelled (item 396): the merchant withdraws an
 * open (requested or approved) return that has not come back, and a courier
 * pickup booked for it is cancelled at the courier first
 * (returns/returnCancel.js). The pickup's own progress lives in the existing
 * return_requests.pickup JSON (status, carrierStatus, history, nextPollAt), so
 * only the status list grows.
 *
 * down: a cancelled return reads as rejected (the closest older status).
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_return_requests_status" ADD VALUE IF NOT EXISTS 'cancelled';`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "return_requests" ALTER COLUMN "status" DROP DEFAULT;
      UPDATE "return_requests" SET "status" = 'rejected' WHERE "status" = 'cancelled';
      ALTER TYPE "enum_return_requests_status" RENAME TO "enum_return_requests_status_old";
      CREATE TYPE "enum_return_requests_status" AS ENUM('requested', 'approved', 'rejected', 'received', 'refunded');
      ALTER TABLE "return_requests" ALTER COLUMN "status" TYPE "enum_return_requests_status"
        USING "status"::text::"enum_return_requests_status";
      ALTER TABLE "return_requests" ALTER COLUMN "status" SET DEFAULT 'requested';
      DROP TYPE "enum_return_requests_status_old";
    `);
  },
};
