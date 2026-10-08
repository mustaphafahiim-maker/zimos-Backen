'use strict';

/**
 * Compares every store's cached balance (workspace_wallets) with its ledger
 * (wallet_ledger_entries), then exits. Read-only: it never writes a row.
 *
 *   node scripts/check-wallet-ledger.js
 *
 * For each wallet: cash_balance must equal the sum of its entries'
 * cash_delta, total_topped_up the sum of its top-ups, and the last entry's
 * balance_after the cached balance; free_orders_granted the sum of its grants'
 * free_orders_delta and free_orders_used minus the rest of it (migration 220).
 * A ledger without a wallet row is reported
 * too. Exits 0 when everything matches, 2 when something doesn't (printed
 * per store), 1 when it could not run.
 */

const { QueryTypes } = require('sequelize');
const db = require('../src/db/models');

async function check() {
  return db.sequelize.query(
    `WITH sums AS (
       SELECT workspace_id,
              SUM(cash_delta)::bigint AS ledger_balance,
              COALESCE(SUM(cash_delta) FILTER (WHERE entry_type = 'topup'), 0)::bigint AS ledger_topped_up,
              COALESCE(SUM(free_orders_delta) FILTER (WHERE entry_type = 'free_orders_grant'), 0)::bigint AS ledger_free_granted,
              COALESCE(-SUM(free_orders_delta) FILTER (WHERE entry_type <> 'free_orders_grant'), 0)::bigint AS ledger_free_used,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries
        GROUP BY workspace_id
     ),
     last_entry AS (
       SELECT DISTINCT ON (workspace_id) workspace_id, balance_after
         FROM wallet_ledger_entries
        ORDER BY workspace_id, created_at DESC, id DESC
     )
     SELECT COALESCE(w.workspace_id, s.workspace_id) AS workspace_id,
            w.cash_balance::bigint AS cached_balance,
            w.total_topped_up::bigint AS cached_topped_up,
            w.free_orders_granted::bigint AS cached_free_granted,
            w.free_orders_used::bigint AS cached_free_used,
            COALESCE(s.ledger_free_granted, 0) AS ledger_free_granted,
            COALESCE(s.ledger_free_used, 0) AS ledger_free_used,
            COALESCE(s.ledger_balance, 0) AS ledger_balance,
            COALESCE(s.ledger_topped_up, 0) AS ledger_topped_up,
            l.balance_after::bigint AS last_balance_after,
            COALESCE(s.entries, 0) AS entries
       FROM workspace_wallets w
       FULL OUTER JOIN sums s ON s.workspace_id = w.workspace_id
       LEFT JOIN last_entry l ON l.workspace_id = COALESCE(w.workspace_id, s.workspace_id)`,
    { type: QueryTypes.SELECT }
  );
}

function problemsOf(row) {
  const problems = [];
  if (row.cached_balance === null) problems.push('ledger entries without a wallet row');
  else {
    if (Number(row.cached_balance) !== Number(row.ledger_balance)) {
      problems.push(`balance ${row.cached_balance} but the ledger sums to ${row.ledger_balance}`);
    }
    if (Number(row.cached_topped_up) !== Number(row.ledger_topped_up)) {
      problems.push(`topped up ${row.cached_topped_up} but the ledger's top-ups sum to ${row.ledger_topped_up}`);
    }
    if (Number(row.cached_free_granted) !== Number(row.ledger_free_granted)) {
      problems.push(`free orders granted ${row.cached_free_granted} but the ledger's grants sum to ${row.ledger_free_granted}`);
    }
    if (Number(row.cached_free_used) !== Number(row.ledger_free_used)) {
      problems.push(`free orders used ${row.cached_free_used} but the ledger says ${row.ledger_free_used}`);
    }
    if (row.entries > 0 && Number(row.last_balance_after) !== Number(row.cached_balance)) {
      problems.push(`the last entry ends at ${row.last_balance_after}, not ${row.cached_balance}`);
    }
  }
  return problems;
}

async function main() {
  const rows = await check();
  let bad = 0;
  for (const row of rows) {
    const problems = problemsOf(row);
    if (problems.length > 0) {
      bad += 1;
      console.log(`workspace ${row.workspace_id}: ${problems.join('; ')}`);
    }
  }
  console.log(`${rows.length} wallet(s) checked, ${bad} with a difference.`);
  return bad;
}

if (require.main === module) {
  main()
    .then((bad) => {
      process.exitCode = bad > 0 ? 2 : 0;
    })
    .catch((err) => {
      console.error(`Could not check the wallets: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.sequelize.close());
}

module.exports = { check, problemsOf };
