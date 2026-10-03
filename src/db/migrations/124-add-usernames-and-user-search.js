'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');
const { usernameBase, usernameProblem } = require('../../modules/users/username');

/**
 * Usernames, and the indexes behind the platform console's user search.
 *
 *  - users.username VARCHAR(30) NULL — always stored lower-case (see
 *    modules/users/username.js), unique regardless of case through a partial
 *    unique index on lower(username).
 *  - users.username_changed_at — when the owner last changed it (one change
 *    per 30 days; the first choice does not count).
 *  - Backfill: every existing user gets one from their email's local part,
 *    cleaned to the rules; a clash or a reserved name gets a short random
 *    numeric suffix. Done in batches of plain row updates (no table lock),
 *    before the unique index exists, with the names already taken tracked in
 *    memory so no two users get the same one.
 *  - Trigram (GIN) indexes for the search, CONCURRENTLY: the normalised full
 *    name (zimos_normalize_search, migration 088), the username, the email,
 *    and the workspace name and slug.
 *
 * sequelize-cli runs a migration without a wrapping transaction, which is what
 * CONCURRENTLY needs; every step is safe to run again.
 */

const UNIQUE_INDEX = 'users_username_lower_unique';
const TRGM_INDEXES = [
  { name: 'users_full_name_trgm_idx', table: 'users', definition: 'USING gin (zimos_normalize_search(full_name) gin_trgm_ops)' },
  { name: 'users_username_trgm_idx', table: 'users', definition: 'USING gin (username gin_trgm_ops) WHERE username IS NOT NULL' },
  { name: 'users_email_trgm_idx', table: 'users', definition: 'USING gin (lower(email::text) gin_trgm_ops)' },
  { name: 'workspaces_name_trgm_idx', table: 'workspaces', definition: 'USING gin (zimos_normalize_search(name) gin_trgm_ops)' },
  { name: 'workspaces_slug_trgm_idx', table: 'workspaces', definition: 'USING gin (slug gin_trgm_ops)' },
];
const BATCH = 500;

async function backfill(queryInterface) {
  const { QueryTypes } = queryInterface.sequelize;
  const taken = new Set(
    (
      await queryInterface.sequelize.query('SELECT lower(username) AS u FROM users WHERE username IS NOT NULL', {
        type: QueryTypes.SELECT,
      })
    ).map((r) => r.u)
  );
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await queryInterface.sequelize.query(
      `SELECT id, email::text AS email FROM users
        WHERE username IS NULL AND id > $after
        ORDER BY id LIMIT ${BATCH}`,
      { bind: { after }, type: QueryTypes.SELECT }
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const base = usernameBase(row.email);
      let name = !usernameProblem(base) && !taken.has(base) ? base : null;
      for (let i = 0; !name; i += 1) {
        // Four digits, then more if a store has that many of the same name.
        const digits = i < 20 ? 4 : 6;
        const suffix = `_${String(Math.floor(Math.random() * 10 ** digits)).padStart(digits, '0')}`;
        const candidate = `${base.slice(0, 30 - suffix.length)}${suffix}`;
        if (!usernameProblem(candidate) && !taken.has(candidate)) name = candidate;
      }
      taken.add(name);
      await queryInterface.sequelize.query('UPDATE users SET username = $name WHERE id = $id AND username IS NULL', {
        bind: { name, id: row.id },
      });
    }
    after = rows[rows.length - 1].id;
  }
}

module.exports = {
  backfill,

  up: async (queryInterface, Sequelize) => {
    const users = await queryInterface.describeTable('users');
    if (!users.username) {
      await queryInterface.addColumn('users', 'username', { type: Sequelize.STRING(30), allowNull: true });
    }
    if (!users.username_changed_at) {
      await queryInterface.addColumn('users', 'username_changed_at', { type: Sequelize.DATE, allowNull: true });
    }

    await backfill(queryInterface);

    await createIndexConcurrently(queryInterface, {
      name: UNIQUE_INDEX,
      table: 'users',
      definition: '(lower(username)) WHERE username IS NOT NULL',
      unique: true,
    });
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    for (const index of TRGM_INDEXES) await createIndexConcurrently(queryInterface, index);
  },

  down: async (queryInterface) => {
    for (const index of TRGM_INDEXES) await dropIndexConcurrently(queryInterface, index.name);
    await dropIndexConcurrently(queryInterface, UNIQUE_INDEX);
    const users = await queryInterface.describeTable('users');
    if (users.username_changed_at) await queryInterface.removeColumn('users', 'username_changed_at');
    if (users.username) await queryInterface.removeColumn('users', 'username');
  },
};
