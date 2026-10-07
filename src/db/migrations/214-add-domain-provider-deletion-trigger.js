'use strict';

/**
 * Every domain row that goes while it has a custom hostname at the
 * certificate provider (ssl_provider_ref set) leaves one row in
 * domain_provider_deletions (migration 212), in the same transaction, for
 * the domains job to remove at the provider (modules/domains/jobs.js). A
 * BEFORE DELETE trigger, so every path is covered: deleteDomain, the
 * workspace's or website's FK CASCADE, a user's account taking its stores
 * with it, raw SQL. Already queued (same provider and ref): nothing.
 *
 * A row with a ref but no ssl_provider is queued under 'cloudflare', the only
 * adapter there is (modules/domains/certificates).
 *
 * Runs twice safely: the function is CREATE OR REPLACE, the trigger is
 * dropped and made again. down() drops both; the queue keeps its rows.
 */
const FN = 'domains_queue_provider_deletion';
const TRIGGER = 'domains_queue_provider_deletion_trg';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger AS $$
        BEGIN
          IF OLD.ssl_provider_ref IS NOT NULL AND btrim(OLD.ssl_provider_ref) <> '' THEN
            INSERT INTO domain_provider_deletions
              (id, workspace_id, hostname, provider, provider_ref, attempts, next_attempt_at, created_at, updated_at)
            VALUES
              (gen_random_uuid(), OLD.workspace_id, OLD.hostname,
               COALESCE(NULLIF(btrim(OLD.ssl_provider), ''), 'cloudflare'), OLD.ssl_provider_ref,
               0, NOW(), NOW(), NOW())
            ON CONFLICT DO NOTHING;
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql`,
        { transaction }
      );
      await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON domains`, { transaction });
      await queryInterface.sequelize.query(
        `CREATE TRIGGER ${TRIGGER} BEFORE DELETE ON domains FOR EACH ROW EXECUTE FUNCTION ${FN}()`,
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON domains`, { transaction });
      await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${FN}()`, { transaction });
    });
  },
};
