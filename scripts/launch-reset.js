'use strict';

/**
 * Empties the database before launch: every store, every account but the
 * creator's, and everything under them, while the platform's own setup
 * (plans, templates, themes, the app catalogue, payment methods, flags,
 * console roles and settings, the place list, exchange rates, migrations)
 * stays exactly as it is. What happens to each table is in
 * scripts/launch-reset-tables.js.
 *
 *   node scripts/launch-reset.js                     # dry run: counts, changes nothing
 *   node scripts/launch-reset.js --apply --confirm-db <name> --i-know-this-is-production --expect-keep 1
 *
 * The connection comes from DATABASE_URL only (no .env is read), and is never
 * printed. DB_SSL=true, or sslmode=require in the URL, turns SSL on.
 *
 * Refuses, in a dry run too, unless exactly one account has the creator role
 * (users.platform_role = 'creator') and every table in the database is
 * classified. --apply also refuses while a table is still marked "decide",
 * when --confirm-db is not current_database(), and when a row that is kept
 * points at a row that would be deleted (a SET NULL or CASCADE would change it).
 *
 * --apply runs in one transaction that first locks every table against writes
 * (reads go on), then:
 *   1. TRUNCATE ... RESTRICT the "truncate" tables (the wallet ledger refuses
 *      DELETE on its rows); RESTRICT fails rather than reach any other table;
 *   2. DELETE every "wipe" table, children before parents, and every account
 *      but the creator's;
 *   3. checks every emptied table is empty and every kept row has the same
 *      count and checksum as before, and rolls back if anything differs.
 * Sequences are left as they are (CONTINUE IDENTITY). Nothing outside the
 * database is touched: files in R2 or on disk stay where they are. Running it
 * again deletes nothing and changes nothing.
 */

const { Client } = require('pg');
const { parseDbUrl } = require('../src/config/parseDbUrl');
const { TABLES: DEFAULT_TABLES, ACTIONS } = require('./launch-reset-tables');

const CREATOR_ROLE = 'creator';
const LOCK_TIMEOUT = '10s';

const USAGE = [
  'Usage:',
  '  node scripts/launch-reset.js                 dry run (the default): counts only, changes nothing',
  '  node scripts/launch-reset.js --apply --confirm-db <database> --i-know-this-is-production --expect-keep 1',
  'The connection comes from DATABASE_URL.',
].join('\n');

/** A reason not to go on; nothing has changed when one is thrown. */
class Refusal extends Error {}

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

function parseArgs(argv) {
  const opts = { apply: false, confirmDb: undefined, iKnowThisIsProduction: false, expectKeep: undefined };
  const valueOf = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Refusal(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const take = () => {
      if (inline !== undefined) return inline;
      const value = valueOf(i, flag);
      i += 1;
      return value;
    };
    if (flag === '--apply' && inline === undefined) opts.apply = true;
    else if (flag === '--i-know-this-is-production' && inline === undefined) opts.iKnowThisIsProduction = true;
    else if (flag === '--confirm-db') opts.confirmDb = take();
    else if (flag === '--expect-keep') {
      const raw = take();
      if (!/^\d+$/.test(raw)) throw new Refusal(`--expect-keep takes a whole number, not "${raw}"`);
      opts.expectKeep = Number(raw);
    } else throw new Refusal(`unknown argument ${flag}`);
  }
  if (opts.apply) {
    const missing = [];
    if (opts.confirmDb === undefined) missing.push('--confirm-db <database>');
    if (!opts.iKnowThisIsProduction) missing.push('--i-know-this-is-production');
    if (opts.expectKeep === undefined) missing.push('--expect-keep 1');
    if (missing.length) throw new Refusal(`--apply also needs ${missing.join(', ')}`);
  }
  return opts;
}

/** Every table that holds rows, whatever its schema (temporary ones aside). */
async function listTables(client) {
  const { rows } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp\\_%'
     ORDER BY 1, 2`);
  return rows;
}

/**
 * Matches the database's tables against the classification. Only tables in
 * `public` can be classified; one anywhere else is unclassified.
 */
function classify(dbTables, tables) {
  const present = new Set();
  const unclassified = [];
  for (const t of dbTables) {
    if (t.schema === 'public' && Object.prototype.hasOwnProperty.call(tables, t.name)) present.add(t.name);
    else unclassified.push(t.schema === 'public' ? t.name : `${t.schema}.${t.name}`);
  }
  for (const [name, entry] of Object.entries(tables)) {
    if (!entry || !ACTIONS.includes(entry.action)) throw new Refusal(`${name} has no valid action in the classification`);
    if (entry.action === 'keep-creator' && name !== 'users') throw new Refusal(`keep-creator applies to users only, not ${name}`);
  }
  if (!tables.users || tables.users.action !== 'keep-creator') {
    throw new Refusal('users must be classified keep-creator, or the creator would go too');
  }
  const missing = Object.keys(tables).filter((name) => !present.has(name)).sort();
  const byAction = Object.fromEntries(ACTIONS.map((a) => [a, []]));
  for (const name of [...present].sort()) byAction[tables[name].action].push(name);
  return { unclassified, missing, byAction };
}

/** Foreign keys between tables in `public`. */
async function loadForeignKeys(client) {
  const { rows } = await client.query(`
    SELECT con.conname AS name,
           child.relname AS child,
           parent.relname AS parent,
           con.confdeltype AS on_delete,
           ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS child_cols,
           ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) AS parent_cols
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace cn ON cn.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace pn ON pn.oid = parent.relnamespace
     WHERE con.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public'
     ORDER BY 2, 1`);
  return rows;
}

const ON_DELETE = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

/**
 * The order to DELETE in: a table goes once nothing left to delete still
 * points at it. A cycle is broken only across a CASCADE / SET NULL / SET
 * DEFAULT key (deleting the parent first then just empties or clears rows of
 * a table that is going anyway); a cycle of RESTRICT / NO ACTION keys refuses.
 */
function deleteOrder(names, fks) {
  const set = new Set(names);
  const edges = fks
    .filter((fk) => set.has(fk.child) && set.has(fk.parent) && fk.child !== fk.parent)
    .map((fk) => ({ child: fk.child, parent: fk.parent, hard: fk.on_delete === 'r' || fk.on_delete === 'a' }));
  const remaining = new Set(names);
  const order = [];
  const pointedAt = (t, hardOnly) => edges.some((e) => e.parent === t && remaining.has(e.child) && (!hardOnly || e.hard));
  while (remaining.size) {
    let ready = [...remaining].filter((t) => !pointedAt(t, false)).sort();
    if (!ready.length) ready = [...remaining].filter((t) => !pointedAt(t, true)).sort().slice(0, 1);
    if (!ready.length) {
      throw new Refusal(`cannot order the deletes: RESTRICT / NO ACTION keys form a cycle among ${[...remaining].sort().join(', ')}`);
    }
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return order;
}

// pg refuses a parameter the statement does not use.
const paramsFor = (sql, creatorId) => (sql.includes('$1') ? [creatorId] : []);

/** Which rows of a table stay ($1 is the creator's id). */
function keptWhere(action) {
  if (action === 'keep' || action === 'decide') return 'TRUE';
  if (action === 'keep-creator') return 't.id = $1';
  return 'FALSE';
}

/** Which rows of a table go ($1 is the creator's id). */
function deletedWhere(action) {
  if (action === 'wipe' || action === 'truncate') return 'TRUE';
  if (action === 'keep-creator') return 't.id <> $1';
  return 'FALSE';
}

/**
 * Kept rows that point at a row this reset deletes: its ON DELETE would
 * change them (SET NULL, CASCADE) or stop the delete (RESTRICT).
 */
async function keptRowsPointingAtDeleted(client, fks, actionOf, creatorId) {
  const found = [];
  for (const fk of fks) {
    const childAction = actionOf(fk.child);
    const parentAction = actionOf(fk.parent);
    if (!childAction || !parentAction) continue;
    if (keptWhere(childAction) === 'FALSE' || deletedWhere(parentAction) === 'FALSE') continue;
    const childCols = fk.child_cols.map((c) => `c.${quote(c)}`).join(', ');
    const parentCols = fk.parent_cols.map((c) => `t.${quote(c)}`).join(', ');
    const sql = `SELECT count(*)::int AS n FROM ${quote(fk.child)} c
                  WHERE ${keptWhere(childAction).replace(/\bt\./g, 'c.')}
                    AND (${childCols}) IN (SELECT ${parentCols} FROM ${quote(fk.parent)} t WHERE ${deletedWhere(parentAction)})`;
    const { rows } = await client.query(sql, paramsFor(sql, creatorId));
    if (rows[0].n > 0) {
      found.push({ table: fk.child, columns: fk.child_cols, parent: fk.parent, onDelete: ON_DELETE[fk.on_delete], rows: rows[0].n });
    }
  }
  return found;
}

/** Row count and a checksum of the rows (order-independent). */
async function fingerprint(client, table, where, creatorId) {
  const sql = `SELECT count(*)::int AS n,
                      coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') AS sum
                 FROM ${quote(table)} t WHERE ${where}`;
  const { rows } = await client.query(sql, paramsFor(sql, creatorId));
  return { rows: rows[0].n, sum: rows[0].sum };
}

async function countRows(client, table) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${quote(table)}`);
  return rows[0].n;
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function printReport(result, log) {
  log(result.mode === 'apply' ? 'launch-reset: APPLY' : 'launch-reset: DRY RUN (nothing is changed)');
  log(`database: ${result.database} (PostgreSQL ${result.serverVersion})`);
  log(`creator kept: ${result.creator.id} (${result.creator.email})`);
  log('');
  const width = Math.max(...result.tables.map((t) => t.name.length), 5) + 2;
  log(`${'table'.padEnd(width)}${'action'.padEnd(14)}${'rows'.padStart(10)}${'delete'.padStart(10)}`);
  for (const t of result.tables) {
    log(`${t.name.padEnd(width)}${t.action.padEnd(14)}${String(t.rows).padStart(10)}${String(t.toDelete).padStart(10)}`);
  }
  log('');
  log(`to delete: ${result.totals.toDelete} rows in ${result.totals.tablesWithRows} tables; kept: ${result.totals.kept} rows`);
  log(`order: TRUNCATE ${result.truncate.join(', ') || '(none)'}; then DELETE ${result.order.join(', ')}`);
  if (result.missing.length) log(`classified but not in this database (nothing to do): ${result.missing.join(', ')}`);
  if (result.decide.length) {
    log('');
    log('Needs a decision (kept as they are until decided; --apply refuses while any is listed):');
    for (const d of result.decide) log(`  ${d.name} (${d.rows} rows): ${d.why}`);
  }
  if (result.pointing.length) {
    log('');
    log('Kept rows that point at rows this reset deletes (--apply refuses while any is listed):');
    for (const p of result.pointing) {
      log(`  ${p.table}.${p.columns.join(',')} -> ${p.parent} (ON DELETE ${p.onDelete}): ${p.rows} rows`);
    }
  }
}

/**
 * Plans the reset and, with `apply`, carries it out. `client` is a connected
 * pg Client; the transaction is begun and ended here.
 */
async function run(client, { apply = false, confirmDb, iKnowThisIsProduction = false, expectKeep, tables = DEFAULT_TABLES, log = console.log } = {}) {
  if (apply && (confirmDb === undefined || !iKnowThisIsProduction || expectKeep === undefined)) {
    throw new Refusal('--apply needs --confirm-db, --i-know-this-is-production and --expect-keep');
  }
  const { rows: [{ database, serverVersion }] } = await client.query(
    "SELECT current_database() AS database, current_setting('server_version') AS \"serverVersion\""
  );
  if (confirmDb !== undefined && confirmDb !== database) {
    throw new Refusal(`--confirm-db "${confirmDb}" is not the database this connects to ("${database}")`);
  }

  await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const { unclassified, missing, byAction } = classify(await listTables(client), tables);
    if (unclassified.length) {
      throw new Refusal(`not classified in scripts/launch-reset-tables.js: ${unclassified.join(', ')}`);
    }
    if (apply && byAction.decide.length) {
      throw new Refusal(`still marked "decide" in scripts/launch-reset-tables.js: ${byAction.decide.join(', ')}`);
    }
    const present = Object.values(byAction).flat();

    if (apply) {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query(`LOCK TABLE ${present.map(quote).join(', ')} IN EXCLUSIVE MODE`);
    }

    const { rows: creators } = await client.query('SELECT id, email FROM users WHERE platform_role = $1', [CREATOR_ROLE]);
    if (creators.length !== 1) {
      throw new Refusal(`expected exactly one account with platform_role '${CREATOR_ROLE}', found ${creators.length}`);
    }
    if (expectKeep !== undefined && expectKeep !== creators.length) {
      throw new Refusal(`--expect-keep ${expectKeep}, but ${creators.length} creator account would be kept`);
    }
    const creator = creators[0];

    const actionOf = (name) => (present.includes(name) ? tables[name].action : undefined);
    const fks = await loadForeignKeys(client);
    const order = deleteOrder([...byAction.wipe, ...byAction['keep-creator']], fks);
    const truncate = byAction.truncate;
    const pointing = await keptRowsPointingAtDeleted(client, fks, actionOf, creator.id);

    const rowsBefore = {};
    for (const name of present) rowsBefore[name] = await countRows(client, name);
    const toDeleteOf = (name) => {
      const action = tables[name].action;
      if (action === 'wipe' || action === 'truncate') return rowsBefore[name];
      if (action === 'keep-creator') return rowsBefore[name] - 1;
      return 0;
    };
    const listed = [...present].sort((a, b) => a.localeCompare(b));
    const result = {
      mode: apply ? 'apply' : 'dry-run',
      database,
      serverVersion,
      creator: { id: creator.id, email: maskEmail(creator.email) },
      tables: listed.map((name) => ({ name, action: tables[name].action, rows: rowsBefore[name], toDelete: toDeleteOf(name) })),
      decide: byAction.decide.map((name) => ({ name, rows: rowsBefore[name], why: tables[name].why })),
      pointing,
      missing,
      truncate,
      order,
      deleted: {},
      applied: false,
    };
    result.totals = {
      toDelete: result.tables.reduce((s, t) => s + t.toDelete, 0),
      tablesWithRows: result.tables.filter((t) => t.toDelete > 0).length,
      kept: result.tables.reduce((s, t) => s + t.rows - t.toDelete, 0),
    };
    printReport(result, log);

    if (!apply) {
      await client.query('ROLLBACK');
      return result;
    }

    if (pointing.length) {
      throw new Refusal('kept rows point at rows this reset deletes (listed above); classify those tables first');
    }
    for (const fk of fks) {
      if (truncate.includes(fk.parent) && !truncate.includes(fk.child)) {
        throw new Refusal(`${fk.child} points at ${fk.parent}, so TRUNCATE ${fk.parent} would have to reach it`);
      }
    }

    const keptTables = [...byAction.keep, ...byAction['keep-creator']];
    const before = {};
    for (const name of keptTables) before[name] = await fingerprint(client, name, keptWhere(tables[name].action), creator.id);

    if (truncate.length) {
      await client.query(`TRUNCATE TABLE ${truncate.map(quote).join(', ')} CONTINUE IDENTITY RESTRICT`);
      for (const name of truncate) result.deleted[name] = rowsBefore[name];
    }
    for (const name of order) {
      const where = deletedWhere(tables[name].action);
      const sql = `DELETE FROM ${quote(name)} t WHERE ${where}`;
      const res = await client.query(sql, paramsFor(sql, creator.id));
      result.deleted[name] = res.rowCount;
    }

    const problems = [];
    for (const name of [...truncate, ...byAction.wipe]) {
      const left = await countRows(client, name);
      if (left !== 0) problems.push(`${name} still has ${left} rows`);
    }
    for (const name of keptTables) {
      const after = await fingerprint(client, name, keptWhere(tables[name].action), creator.id);
      if (after.rows !== before[name].rows || after.sum !== before[name].sum) {
        problems.push(`${name}: kept rows changed (${before[name].rows} -> ${after.rows} rows, checksum ${after.sum === before[name].sum ? 'same' : 'differs'})`);
      }
    }
    for (const name of byAction['keep-creator']) {
      const left = await countRows(client, name);
      if (left !== 1) problems.push(`${name} has ${left} rows, not just the creator's`);
    }
    if (problems.length) throw new Error(`checks failed, rolled back:\n  ${problems.join('\n  ')}`);

    await client.query('COMMIT');
    result.applied = true;
    const total = Object.values(result.deleted).reduce((s, n) => s + n, 0);
    log('');
    log(total === 0 ? 'Done: nothing to delete, nothing changed.' : `Done: deleted ${total} rows; every kept row is unchanged.`);
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`Refused: ${err.message}\n${USAGE}`);
    return 1;
  }
  if (!env.DATABASE_URL) {
    log(`Refused: DATABASE_URL is not set.\n${USAGE}`);
    return 1;
  }
  let conn;
  try {
    conn = parseDbUrl(env.DATABASE_URL);
  } catch (err) {
    log(`Refused: ${err.message}`);
    return 1;
  }
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.name,
    ssl: conn.ssl || env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'launch-reset',
  });
  try {
    await client.connect();
    await run(client, { ...opts, log });
    return 0;
  } catch (err) {
    log(err instanceof Refusal ? `Refused: ${err.message}` : `Failed, nothing changed: ${err.message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { run, main, parseArgs, classify, listTables, loadForeignKeys, deleteOrder, Refusal, CREATOR_ROLE };
