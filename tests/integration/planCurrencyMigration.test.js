'use strict';

// Migration 128: plans.currency defaults to EGP, and USD plans are relabelled
// EGP unless a subscription on them carries money in another currency. Runs
// the migration module directly against the test database (already migrated,
// so an `up` here only finds the plans a test makes); SequelizeMeta is not
// touched, and every test leaves the schema as the migration left it.

const crypto = require('crypto');
const { Sequelize } = require('sequelize');
const db = require('../../src/db/models');
const migration = require('../../src/db/migrations/128-default-plan-currency-egp');
const { registerAndActivate, createWorkspace } = require('../helpers/factories');

const qi = () => db.sequelize.getQueryInterface();

let seq = 0;
function makePlan(currency) {
  seq += 1;
  return db.Plan.create({
    key: `currency-${seq}`,
    name: `Currency ${seq}`,
    monthlyPriceAmount: 29900,
    yearlyPriceAmount: 299000,
    currency,
  });
}

/** A store whose subscription is on `plan`. */
async function subscribeTo(plan) {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Currency Co');
  const subscription = await db.Subscription.findOne({ where: { workspaceId: workspace.id } });
  await subscription.update({ planId: plan.id });
  return { subscription, userId: auth.userId };
}

function charge(subscription, currency) {
  const now = new Date();
  return db.BillingInvoice.create({
    workspaceId: subscription.workspaceId,
    subscriptionId: subscription.id,
    amount: 29900,
    currency,
    status: 'paid',
    periodStart: now,
    periodEnd: new Date(now.getTime() + 30 * 86400000),
    paidAt: now,
  });
}

function priceOverride(subscription, { currency, chargesTotal, chargesUsed }) {
  return db.SubscriptionTerm.create({
    subscriptionId: subscription.id,
    workspaceId: subscription.workspaceId,
    kind: 'price_override',
    priceAmount: 9900,
    currency,
    chargesTotal,
    chargesUsed,
    note: 'launch price',
  });
}

async function columnDefault() {
  const [rows] = await db.sequelize.query(
    "SELECT column_default FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'currency'"
  );
  return rows[0].column_default;
}

async function currencyOf(plan) {
  return (await plan.reload()).currency;
}

describe('migration 128 — plans are priced in EGP unless they say otherwise', () => {
  let warn;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const warnings = () => warn.mock.calls.map((call) => call[0]).join('\n');

  it('defaults the column to EGP, so a plan written without a currency is EGP', async () => {
    expect(await columnDefault()).toMatch(/^'EGP'/);

    await db.sequelize.query(
      "INSERT INTO plans (id, key, name, monthly_price_amount, yearly_price_amount) VALUES (:id, 'raw', 'Raw', 0, 0)",
      { replacements: { id: crypto.randomUUID() } }
    );
    const [[raw]] = await db.sequelize.query("SELECT currency FROM plans WHERE key = 'raw'");
    expect(raw.currency).toBe('EGP');

    const viaModel = await db.Plan.create({ key: 'model', name: 'Model', monthlyPriceAmount: 0, yearlyPriceAmount: 0 });
    expect(viaModel.currency).toBe('EGP');
    expect(await currencyOf(viaModel)).toBe('EGP');
  });

  it('relabels a USD plan only when no subscription on it carries money in another currency', async () => {
    const unused = await makePlan('USD');
    const billedInEgp = await makePlan('USD');
    const billedInUsd = await makePlan('USD');
    const specialPrice = await makePlan('USD');
    const fixedDiscount = await makePlan('USD');
    const pounds = await makePlan('GBP');

    // EGP charges, and a USD special price that is used up, change nothing.
    const { subscription: egpSub } = await subscribeTo(billedInEgp);
    await charge(egpSub, 'EGP');
    await priceOverride(egpSub, { currency: 'USD', chargesTotal: 2, chargesUsed: 2 });

    const { subscription: usdSub } = await subscribeTo(billedInUsd);
    await charge(usdSub, 'USD');

    const { subscription: termSub } = await subscribeTo(specialPrice);
    await priceOverride(termSub, { currency: 'USD', chargesTotal: 3, chargesUsed: 1 });

    const { subscription: codeSub, userId } = await subscribeTo(fixedDiscount);
    const code = await db.ReferralCode.create({
      agentId: userId,
      code: 'TENOFF',
      discountType: 'fixed',
      discountValue: 1000,
      discountCurrency: 'USD',
    });
    await codeSub.update({ referralCodeId: code.id, referralCodeAttachedAt: new Date() });

    const result = await migration.up(qi(), Sequelize);

    expect(await currencyOf(unused)).toBe('EGP');
    expect(await currencyOf(billedInEgp)).toBe('EGP');
    expect(await currencyOf(billedInUsd)).toBe('USD');
    expect(await currencyOf(specialPrice)).toBe('USD');
    expect(await currencyOf(fixedDiscount)).toBe('USD');
    expect(await currencyOf(pounds)).toBe('GBP');
    expect(result.relabelled.sort()).toEqual([unused.key, billedInEgp.key].sort());
    expect(result.skipped.sort()).toEqual([billedInUsd.key, specialPrice.key, fixedDiscount.key].sort());

    // A warning per plan left alone, naming what holds it.
    expect(warnings()).toContain(`plan "${billedInUsd.key}" (${billedInUsd.id}) stays USD: its subscriptions have billing invoices in USD`);
    expect(warnings()).toContain(`plan "${specialPrice.key}" (${specialPrice.id}) stays USD: its subscriptions have a special price in USD`);
    expect(warnings()).toContain(
      `plan "${fixedDiscount.key}" (${fixedDiscount.id}) stays USD: its subscriptions have a fixed referral discount in USD`
    );
    expect(warn).toHaveBeenCalledTimes(3);

    // Each relabelled plan is in the audit log, without an actor.
    const entries = await db.AuditLog.findAll({ where: { action: 'plan.currency_relabelled' } });
    expect(entries.map((e) => e.entityId).sort()).toEqual([unused.id, billedInEgp.id].sort());
    expect(entries[0].actorUserId).toBeNull();
    expect(entries[0].beforeState).toEqual({ currency: 'USD' });
    expect(entries[0].afterState).toEqual({ currency: 'EGP' });
    expect(entries[0].metadata).toEqual({ migration: migration.NAME });
  });

  it('goes down to the USD default and back to USD for the plans it relabelled, then up again', async () => {
    const relabelled = await makePlan('USD');
    const billedSince = await makePlan('USD');
    const alreadyEgp = await makePlan('EGP');

    try {
      await migration.up(qi(), Sequelize);
      expect(await currencyOf(relabelled)).toBe('EGP');
      expect(await currencyOf(billedSince)).toBe('EGP');

      // After the migration: a plan made without a currency, and an EGP charge
      // on a relabelled plan, which keeps it from going back to USD.
      const later = await db.Plan.create({ key: 'later', name: 'Later', monthlyPriceAmount: 0, yearlyPriceAmount: 0 });
      const { subscription } = await subscribeTo(billedSince);
      await charge(subscription, 'EGP');

      const down = await migration.down(qi(), Sequelize);

      expect(await columnDefault()).toMatch(/^'USD'/);
      expect(down).toEqual({ relabelled: [relabelled.key], skipped: [billedSince.key] });
      expect(await currencyOf(relabelled)).toBe('USD');
      expect(await currencyOf(billedSince)).toBe('EGP');
      expect(await currencyOf(alreadyEgp)).toBe('EGP');
      expect(await currencyOf(later)).toBe('EGP');
      expect(warnings()).toContain(`plan "${billedSince.key}" (${billedSince.id}) stays EGP: its subscriptions have billing invoices in EGP`);
    } finally {
      await migration.up(qi(), Sequelize);
    }

    expect(await columnDefault()).toMatch(/^'EGP'/);
    expect(await currencyOf(relabelled)).toBe('EGP');
  });
});
