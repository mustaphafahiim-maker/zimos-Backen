'use strict';

/**
 * Plans are priced in EGP unless they say otherwise.
 *
 * plans.currency defaults to 'EGP' instead of 'USD' (models/Plan.js has the
 * same default, and that is what a Plan.create without a currency writes).
 *
 * Existing USD plans are relabelled EGP. Only the label changes: a plan at
 * 29900 stays 29900 and now reads EGP 299 instead of $299, and that is what
 * its subscribers are charged from their next charge on.
 *
 * A USD plan is left as it is, with a warning in the migration output, when a
 * subscription on it carries money in a currency other than EGP:
 *   - a billing_invoices row (paid or pending) — relabelling would contradict
 *     what was charged;
 *   - a special-price override with charges left (subscription_terms) — the
 *     charge path only applies one in the plan's currency, so it would be
 *     dropped without a word;
 *   - a fixed referral discount — likewise only applied in its own currency.
 * Invoices are tied to a plan through the subscription now on it
 * (billing_invoices has no plan_id). Such a plan can be moved by hand once
 * someone decides what its subscribers should pay.
 *
 * Each relabelled plan gets an audit_logs row (no actor), so the change shows
 * in the console and `down` can tell which plans it relabelled: it puts the
 * default back to USD and those plans back to USD, under the same rule the
 * other way round (no money in a currency other than USD).
 */

const crypto = require('crypto');

const NAME = '128-default-plan-currency-egp';
const RELABELLED = 'plan.currency_relabelled';
const REVERTED = 'plan.currency_relabel_reverted';

/**
 * The plans among `planIds` whose subscriptions carry no money in a currency
 * other than `to`; the rest come back as blocked, with the currencies found.
 */
async function split(sequelize, planIds, to, transaction) {
  if (planIds.length === 0) return { movable: [], blocked: [] };
  const [rows] = await sequelize.query(
    `SELECT p.id, p.key,
            (SELECT string_agg(DISTINCT bi.currency, ', ')
               FROM billing_invoices bi JOIN subscriptions s ON s.id = bi.subscription_id
              WHERE s.plan_id = p.id AND bi.currency <> :to) AS invoices,
            (SELECT string_agg(DISTINCT st.currency, ', ')
               FROM subscription_terms st JOIN subscriptions s ON s.id = st.subscription_id
              WHERE s.plan_id = p.id AND st.kind = 'price_override'
                AND st.charges_used < st.charges_total AND st.currency <> :to) AS overrides,
            (SELECT string_agg(DISTINCT rc.discount_currency, ', ')
               FROM subscriptions s JOIN referral_codes rc ON rc.id = s.referral_code_id
              WHERE s.plan_id = p.id AND rc.discount_type = 'fixed' AND rc.discount_currency <> :to) AS discounts
       FROM plans p
      WHERE p.id IN (:planIds)
      ORDER BY p.key
        FOR UPDATE OF p`,
    { replacements: { planIds, to }, transaction }
  );
  const movable = [];
  const blocked = [];
  for (const row of rows) {
    const found = [
      row.invoices && `billing invoices in ${row.invoices}`,
      row.overrides && `a special price in ${row.overrides}`,
      row.discounts && `a fixed referral discount in ${row.discounts}`,
    ].filter(Boolean);
    if (found.length === 0) movable.push(row);
    else blocked.push({ ...row, found });
  }
  return { movable, blocked };
}

/** Moves the movable plans from `from` to `to`, audits each, and warns about the rest. */
async function relabel(sequelize, planIds, { from, to, action }, transaction) {
  const { movable, blocked } = await split(sequelize, planIds, to, transaction);
  if (movable.length > 0) {
    const ids = movable.map((p) => p.id);
    await sequelize.query(
      'UPDATE plans SET currency = :to, updated_at = NOW() WHERE id IN (:ids) AND currency = :from',
      { replacements: { ids, from, to }, transaction }
    );
    for (const id of ids) {
      await sequelize.query(
        `INSERT INTO audit_logs (id, action, entity_type, entity_id, before_state, after_state, metadata, created_at)
         VALUES (:auditId, :action, 'Plan', :id, :before, :after, :metadata, NOW())`,
        {
          replacements: {
            auditId: crypto.randomUUID(),
            action,
            id,
            before: JSON.stringify({ currency: from }),
            after: JSON.stringify({ currency: to }),
            metadata: JSON.stringify({ migration: NAME }),
          },
          transaction,
        }
      );
    }
  }
  for (const plan of blocked) {
    console.warn(
      `[${NAME}] WARNING: plan "${plan.key}" (${plan.id}) stays ${from}: its subscriptions have ${plan.found.join('; ')}. ` +
        `Change its currency by hand once that is settled.`
    );
  }
  return { relabelled: movable.map((p) => p.key), skipped: blocked.map((p) => p.key) };
}

module.exports = {
  NAME,
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    return sequelize.transaction(async (transaction) => {
      await sequelize.query("ALTER TABLE plans ALTER COLUMN currency SET DEFAULT 'EGP'", { transaction });
      const [plans] = await sequelize.query("SELECT id FROM plans WHERE currency = 'USD'", { transaction });
      return relabel(sequelize, plans.map((p) => p.id), { from: 'USD', to: 'EGP', action: RELABELLED }, transaction);
    });
  },

  down: async (queryInterface) => {
    const { sequelize } = queryInterface;
    return sequelize.transaction(async (transaction) => {
      await sequelize.query("ALTER TABLE plans ALTER COLUMN currency SET DEFAULT 'USD'", { transaction });
      // A plan's latest entry from this migration says whether it is still
      // relabelled (after an up, down, up the second up is what counts).
      const [plans] = await sequelize.query(
        `SELECT latest.entity_id AS id
           FROM (SELECT DISTINCT ON (entity_id) entity_id, action
                   FROM audit_logs
                  WHERE entity_type = 'Plan' AND action IN (:actions) AND metadata->>'migration' = :name
                  ORDER BY entity_id, created_at DESC) latest
           JOIN plans p ON p.id::text = latest.entity_id
          WHERE latest.action = :relabelled AND p.currency = 'EGP'`,
        { replacements: { actions: [RELABELLED, REVERTED], name: NAME, relabelled: RELABELLED }, transaction }
      );
      return relabel(sequelize, plans.map((p) => p.id), { from: 'EGP', to: 'USD', action: REVERTED }, transaction);
    });
  },
};
