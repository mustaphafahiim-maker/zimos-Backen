#!/usr/bin/env node
'use strict';

/**
 * One-off: brings product_variants.reserved_stock back in line with the orders
 * that hold stock, after releases that gave back less (or more) than an order
 * had reserved — an offer of two pieces, a bundle of different variants, an
 * order bump released as one unit of its anchor variant; a cancellation after
 * a rejection releasing twice.
 *
 * A variant's expected reserved stock is what every order that still holds
 * stock reserved for it: every order not cancelled and not rejected — shipped
 * and delivered ones included, since nothing converts a reservation into a
 * deduction (inventoryService.commit is never called; available stock is on
 * hand − reserved). The same rules as modules/inventory/orderStock.js:
 *   - an order whose reservations name it (reference_id, createOrder since
 *     this fix): its 'order_pending' and 'order_upsell' reservations;
 *   - an order from before: its lines — an offer line as its offer's current
 *     lines × the quantity, any other line as its variant × the quantity.
 *
 * Dry run by default: prints every variant whose reserved stock differs from
 * the expected, and writes nothing. Pass --apply to correct them: each
 * variant is locked, checked again and set to the expected value in its own
 * transaction, with a stock movement ('reserve' or 'release', reference type
 * 'reserved_stock_reconcile') recording the change.
 *
 *   node scripts/reconcile-reserved-stock.js                     # dry run, every store
 *   node scripts/reconcile-reserved-stock.js --workspace <uuid>  # one store
 *   node scripts/reconcile-reserved-stock.js --apply             # correct
 *   node scripts/reconcile-reserved-stock.js --apply --batch 25  # variants per batch (default 50)
 *
 * Runs against whatever database src/config/env resolves (DATABASE_URL /
 * DB_*) — on Railway, in a shell of the backend service. Safe alongside the
 * API: a correction takes the same variant lock as a reservation.
 */

const db = require('../src/db/models');

const REFERENCE_TYPE = 'reserved_stock_reconcile';

function readArgs(argv) {
  const args = { apply: false, batch: 50, workspace: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--batch') args.batch = Math.max(1, Math.min(500, parseInt(argv[++i], 10) || 50));
    else if (a === '--workspace') args.workspace = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** Every variant of a workspace (or just `variantId`) with its reserved stock and the expected one. */
function expectedSql(oneVariant) {
  return `
    WITH live AS (
      SELECT o.id::text AS id
        FROM orders o
       WHERE o.workspace_id = :workspaceId
         AND o.cancelled_at IS NULL
         AND o.confirmation_state IS DISTINCT FROM 'rejected'
    ),
    stamped AS (
      SELECT DISTINCT m.reference_id AS id
        FROM inventory_movements m
       WHERE m.workspace_id = :workspaceId
         AND m.reference_type = 'order_pending'
         AND m.reference_id IS NOT NULL
    ),
    from_movements AS (
      SELECT m.variant_id, SUM(m.reserved_delta)::bigint AS quantity
        FROM inventory_movements m
        JOIN live l ON l.id = m.reference_id
        JOIN stamped s ON s.id = m.reference_id
       WHERE m.workspace_id = :workspaceId
         AND m.reference_type IN ('order_pending', 'order_upsell')
       GROUP BY m.variant_id
    ),
    legacy_items AS (
      SELECT oi.variant_id, oi.offer_id, oi.quantity
        FROM order_items oi
        JOIN live l ON l.id = oi.order_id::text
       WHERE oi.variant_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM stamped s WHERE s.id = l.id)
    ),
    legacy_offers AS (
      SELECT DISTINCT ov.offer_id FROM offer_variants ov JOIN legacy_items li ON li.offer_id = ov.offer_id
    ),
    from_lines AS (
      SELECT CASE WHEN lo.offer_id IS NULL THEN li.variant_id ELSE ov.variant_id END AS variant_id,
             SUM(CASE WHEN lo.offer_id IS NULL THEN 1 ELSE ov.quantity END * li.quantity)::bigint AS quantity
        FROM legacy_items li
        LEFT JOIN legacy_offers lo ON lo.offer_id = li.offer_id
        LEFT JOIN offer_variants ov ON ov.offer_id = lo.offer_id
       GROUP BY 1
    )
    SELECT v.id, v.sku, v.reserved_stock AS actual,
           (COALESCE(fm.quantity, 0) + COALESCE(fl.quantity, 0))::int AS expected
      FROM product_variants v
      LEFT JOIN from_movements fm ON fm.variant_id = v.id
      LEFT JOIN from_lines fl ON fl.variant_id = v.id
     WHERE v.workspace_id = :workspaceId ${oneVariant ? 'AND v.id = :variantId' : ''}
     ORDER BY v.id`;
}

async function expectedFor(workspaceId, variantId = null, transaction = undefined) {
  return db.sequelize.query(expectedSql(Boolean(variantId)), {
    replacements: { workspaceId, variantId },
    type: db.Sequelize.QueryTypes.SELECT,
    transaction,
  });
}

/** Locks the variant, works its expected value out again under the lock, and corrects it. */
async function correct(workspaceId, variantId) {
  return db.sequelize.transaction(async (transaction) => {
    const variant = await db.ProductVariant.findOne({ where: { id: variantId, workspaceId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!variant) return null;
    const [row] = await expectedFor(workspaceId, variantId, transaction);
    const delta = row.expected - variant.reservedStock;
    if (delta === 0) return 0;
    await variant.update({ reservedStock: row.expected, version: variant.version + 1 }, { transaction });
    await db.InventoryMovement.create(
      {
        workspaceId,
        variantId,
        type: delta > 0 ? 'reserve' : 'release',
        quantityDelta: 0,
        reservedDelta: delta,
        reason: `Reserved stock reconciled with the orders holding it (${variant.reservedStock} → ${row.expected})`,
        referenceType: REFERENCE_TYPE,
        referenceId: null,
        actorUserId: null,
      },
      { transaction }
    );
    return delta;
  });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  console.log(`[reconcile-reserved-stock] ${args.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
  const workspaces = await db.Workspace.findAll({
    where: args.workspace ? { id: args.workspace } : {},
    attributes: ['id', 'name'],
    order: [['id', 'ASC']],
  });
  if (args.workspace && workspaces.length === 0) throw new Error(`No workspace ${args.workspace}`);

  const stats = { workspaces: 0, variants: 0, off: 0, up: 0, down: 0, corrected: 0, failed: 0 };
  for (const ws of workspaces) {
    stats.workspaces += 1;
    const rows = await expectedFor(ws.id);
    const off = rows.filter((r) => r.expected !== r.actual);
    stats.variants += rows.length;
    stats.off += off.length;
    console.log(`[reconcile-reserved-stock] ${ws.id} ${ws.name}: ${rows.length} variant(s), ${off.length} off`);
    for (const r of off) {
      const delta = r.expected - r.actual;
      if (delta > 0) stats.up += 1;
      else stats.down += 1;
      console.log(`  ${r.id} ${r.sku || ''}: reserved ${r.actual}, expected ${r.expected} (${delta > 0 ? '+' : ''}${delta})`);
    }
    if (!args.apply) continue;
    for (let i = 0; i < off.length; i += args.batch) {
      for (const r of off.slice(i, i + args.batch)) {
        try {
          const delta = await correct(ws.id, r.id);
          if (delta) stats.corrected += 1;
        } catch (err) {
          stats.failed += 1;
          console.log(`  ${r.id} — FAILED: ${err.message}`);
        }
      }
      console.log(`[reconcile-reserved-stock] ${ws.id}: ${Math.min(i + args.batch, off.length)}/${off.length} checked`);
    }
  }

  console.log(
    `[reconcile-reserved-stock] done: ${stats.workspaces} store(s), ${stats.variants} variant(s), ${stats.off} off ` +
      `(${stats.down} too high, ${stats.up} too low), ` +
      `${args.apply ? `${stats.corrected} corrected, ${stats.failed} failed` : 'nothing written (dry run)'}`
  );
  if (!args.apply && stats.off > 0) console.log('[reconcile-reserved-stock] run again with --apply to correct them.');
}

main()
  .catch((err) => {
    console.error(`[reconcile-reserved-stock] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
