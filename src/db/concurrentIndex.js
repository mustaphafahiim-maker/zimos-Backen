'use strict';

/**
 * CREATE INDEX CONCURRENTLY for migrations, done safely.
 *
 * A plain CREATE INDEX blocks every write to the table for as long as the
 * build runs; on a table that is already large (orders, products, users,
 * confirmation_tasks) that is an outage for the length of the build.
 * CONCURRENTLY builds without that lock, at two costs this helper handles:
 *
 *  - It cannot run inside a transaction block. sequelize-cli runs each
 *    migration file without a wrapping transaction (see 100 for the same
 *    reasoning around ALTER TYPE), so the query below is sent on its own —
 *    the equivalent of `transaction: false`. Never pass a transaction here.
 *  - A failed or interrupted build leaves an INVALID index behind under the
 *    same name, which `IF NOT EXISTS` would then silently accept. So an
 *    invalid leftover is dropped (concurrently too) and rebuilt, which makes
 *    re-running a migration that died half way safe.
 *
 * `definition` is everything after `ON <table>`: `USING gin (...)` or
 * `(col_a, col_b) WHERE ...`. Names and definitions come from migration code,
 * never from input.
 */
async function createIndexConcurrently(queryInterface, { name, table, definition, unique = false }) {
  const { sequelize } = queryInterface;
  const [rows] = await sequelize.query(
    `SELECT i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $name AND c.relkind = 'i'`,
    { bind: { name } }
  );
  if (rows.length > 0) {
    if (rows[0].valid) return;
    await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name};`);
  }
  await sequelize.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} ${definition};`);
}

async function dropIndexConcurrently(queryInterface, name) {
  await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name};`);
}

module.exports = { createIndexConcurrently, dropIndexConcurrently };
