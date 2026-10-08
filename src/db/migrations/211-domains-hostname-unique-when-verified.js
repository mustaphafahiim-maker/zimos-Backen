'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * A custom domain's hostname is unique only among verified and active rows.
 *
 * Until now hostname was unique across every row (migration 014 made both a
 * UNIQUE constraint, domains_hostname_key, and a unique index,
 * domains_hostname_idx), so anyone could add someone else's domain, leave it
 * unverified, and keep the real owner out with DOMAIN_TAKEN. Now:
 *
 *  - domains_hostname_verified_unique: UNIQUE (hostname) WHERE status IN
 *    ('verified', 'active'), built first while the old uniqueness still holds;
 *  - domains_hostname_lookup_idx: a plain index for lookups by hostname;
 *  - the old constraint and index are dropped.
 *
 * Indexes are built and dropped CONCURRENTLY (sequelize-cli runs a migration
 * without a wrapping transaction); every step is safe to run again.
 *
 * Before the build (item 341, our data): the old uniqueness means no hostname
 * has two verified rows, but a database where 014's uniqueness was ever lost
 * could. Rather than fail half way, such a hostname keeps one usable row —
 * an active one first, then the earliest verified, then the oldest — and the
 * others become `failed` and lose `is_primary`: kept, never deleted, so the
 * merchant still sees them and support can sort them out; not served.
 *
 * down() brings back the old uniqueness. Rows the old rule could not hold
 * (several rows for one hostname, possible only after up()) would make that
 * fail, so down() first removes the extra unverified rows for such a hostname,
 * keeping a verified or active row if there is one, else the oldest. They are
 * unverified claims with no certificate: nothing else points at them.
 */

const PARTIAL = 'domains_hostname_verified_unique';
const LOOKUP = 'domains_hostname_lookup_idx';
const OLD_CONSTRAINT = 'domains_hostname_key';
const OLD_INDEX = 'domains_hostname_idx';

async function constraintExists(sequelize, name) {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $name AND conrelid = 'domains'::regclass`,
    { bind: { name } }
  );
  return rows.length > 0;
}

module.exports = {
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    const [, demoted] = await sequelize.query(`
      UPDATE domains d
         SET status = 'failed', is_primary = false, updated_at = NOW()
        FROM (
          SELECT id, row_number() OVER (
                   PARTITION BY hostname
                   ORDER BY (status = 'active') DESC, verified_at ASC NULLS LAST, created_at ASC, id ASC
                 ) AS rank
            FROM domains
           WHERE status IN ('verified', 'active')
        ) ranked
       WHERE d.id = ranked.id
         AND ranked.rank > 1
    `);
    const count = demoted && typeof demoted.rowCount === 'number' ? demoted.rowCount : 0;
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.warn(`211: ${count} duplicate verified domain row(s) set to failed, one kept per hostname`);
    }
    await createIndexConcurrently(queryInterface, {
      name: PARTIAL,
      table: 'domains',
      definition: "(hostname) WHERE status IN ('verified', 'active')",
      unique: true,
    });
    await createIndexConcurrently(queryInterface, { name: LOOKUP, table: 'domains', definition: '(hostname)' });
    if (await constraintExists(sequelize, OLD_CONSTRAINT)) {
      await sequelize.query(`ALTER TABLE domains DROP CONSTRAINT ${OLD_CONSTRAINT}`);
    }
    await dropIndexConcurrently(queryInterface, OLD_INDEX);
  },

  down: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await sequelize.query(`
      DELETE FROM domains d
       USING (
         SELECT id, row_number() OVER (
                  PARTITION BY hostname
                  ORDER BY (status IN ('verified', 'active')) DESC, created_at ASC, id ASC
                ) AS rank
           FROM domains
       ) ranked
       WHERE d.id = ranked.id
         AND ranked.rank > 1
         AND d.status NOT IN ('verified', 'active')
    `);
    await createIndexConcurrently(queryInterface, { name: OLD_INDEX, table: 'domains', definition: '(hostname)', unique: true });
    if (!(await constraintExists(sequelize, OLD_CONSTRAINT))) {
      await createIndexConcurrently(queryInterface, { name: OLD_CONSTRAINT, table: 'domains', definition: '(hostname)', unique: true });
      await sequelize.query(`ALTER TABLE domains ADD CONSTRAINT ${OLD_CONSTRAINT} UNIQUE USING INDEX ${OLD_CONSTRAINT}`);
    }
    await dropIndexConcurrently(queryInterface, LOOKUP);
    await dropIndexConcurrently(queryInterface, PARTIAL);
  },
};
