'use strict';

const { nameIndex } = require('sequelize/lib/utils');

/**
 * Run-twice guards for migrations written with queryInterface's helpers.
 *
 * `guarded(queryInterface)` answers like queryInterface, except that:
 *  - createTable skips a table that already exists, and resolves to true only
 *    when it made the table, so seeding it can run on that answer alone;
 *  - addColumn skips a column that already exists, and resolves to true only
 *    when it added the column, so a backfill can run on that answer alone;
 *  - removeColumn skips a column that is already gone;
 *  - addIndex skips an index that already exists under its name. On a table
 *    this migration did not create, and outside a transaction, it builds the
 *    index CONCURRENTLY (no write lock on a large table); an invalid leftover
 *    of a build that died half way is dropped and built again;
 *  - removeIndex skips an index that is already gone;
 *  - addConstraint skips a constraint whose name already exists.
 * dropTable already says IF EXISTS. Everything else passes through, and a
 * migration's own sequelize.query calls are that migration's to guard.
 */

const plainName = (table) => (table && typeof table === 'object' ? table.tableName : table);

function guarded(queryInterface) {
  const { sequelize } = queryInterface;
  const createdHere = new Set();
  const one = async (sql, replacements, transaction) => {
    const [rows] = await sequelize.query(sql, { replacements, transaction });
    return rows[0] || null;
  };

  const tableExists = (table, transaction) =>
    one('SELECT to_regclass(:name) AS oid', { name: `public.${plainName(table)}` }, transaction).then((row) => Boolean(row && row.oid));

  const columnExists = (table, column, transaction) =>
    one(
      `SELECT 1 AS present FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = :table AND column_name = :column`,
      { table: plainName(table), column },
      transaction
    ).then(Boolean);

  const indexState = (name, transaction) =>
    one(
      `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = :name AND c.relkind = 'i'`,
      { name },
      transaction
    );

  const guards = {
    async createTable(table, attributes, options = {}) {
      if (await tableExists(table, options.transaction)) return false;
      await queryInterface.createTable(table, attributes, options);
      createdHere.add(plainName(table));
      return true;
    },

    async addColumn(table, column, definition, options = {}) {
      if (await columnExists(table, column, options.transaction)) return false;
      await queryInterface.addColumn(table, column, definition, options);
      return true;
    },

    async removeColumn(table, column, options = {}) {
      if (!(await columnExists(table, column, options.transaction))) return;
      await queryInterface.removeColumn(table, column, options);
    },

    async addIndex(table, attributes, options) {
      const opts = Array.isArray(attributes) ? { ...(options || {}), fields: attributes } : { ...(attributes || {}) };
      const name = opts.name || nameIndex({ fields: opts.fields }, plainName(table)).name;
      const { transaction } = opts;
      const state = await indexState(name, transaction);
      if (state && state.valid) return;
      const concurrently = !transaction && !createdHere.has(plainName(table));
      if (state) await sequelize.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS "${name}"`, { transaction });
      await queryInterface.addIndex(table, { ...opts, name, concurrently: Boolean(opts.concurrently || concurrently) });
    },

    async removeIndex(table, indexOrAttributes, options = {}) {
      const name = typeof indexOrAttributes === 'string' ? indexOrAttributes : nameIndex({ fields: indexOrAttributes }, plainName(table)).name;
      if (!(await indexState(name, options.transaction))) return;
      await queryInterface.removeIndex(table, name, options);
    },

    async addConstraint(table, options = {}) {
      if (options.name) {
        const found = await one('SELECT 1 AS present FROM pg_constraint WHERE conname = :name', { name: options.name }, options.transaction);
        if (found) return;
      }
      await queryInterface.addConstraint(table, options);
    },
  };

  return new Proxy(queryInterface, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(guards, prop)) return guards[prop];
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = { guarded };
