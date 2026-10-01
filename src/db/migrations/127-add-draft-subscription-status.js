'use strict';

/**
 * subscriptions.status gains 'draft': a store made while
 * REQUIRE_SUBSCRIPTION_TO_GO_LIVE is on, which can be built but not published
 * or sell until a trial or a paid subscription starts (see
 * workspaces/workspaceAccessService — the one place a draft is recognised).
 * Every path that starts a subscription already writes 'trialing' or
 * 'active', so each of them takes a store out of draft without knowing about
 * it: start-trial, the console's manual activation, a recorded payment.
 *
 * The column is an enum from before the VARCHAR + CHECK convention; a new
 * value of an existing enum is added on its own, outside any other change.
 * ADD VALUE cannot be undone in place, so `down` rebuilds the type, moving
 * any draft row back to trialing — what the store would have been without
 * the flag.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_subscriptions_status" ADD VALUE IF NOT EXISTS 'draft';`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "subscriptions" ALTER COLUMN "status" DROP DEFAULT;
      UPDATE "subscriptions" SET "status" = 'trialing' WHERE "status" = 'draft';
      ALTER TYPE "enum_subscriptions_status" RENAME TO "enum_subscriptions_status_old";
      CREATE TYPE "enum_subscriptions_status" AS ENUM('trialing', 'active', 'past_due', 'suspended', 'cancelled');
      ALTER TABLE "subscriptions" ALTER COLUMN "status" TYPE "enum_subscriptions_status"
        USING "status"::text::"enum_subscriptions_status";
      ALTER TABLE "subscriptions" ALTER COLUMN "status" SET DEFAULT 'trialing';
      DROP TYPE "enum_subscriptions_status_old";
    `);
  },
};
