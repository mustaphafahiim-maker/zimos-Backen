'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * Plans, trials and sign-up.
 *
 *  plans               max_stores and max_funnels_per_month (NULL = no limit,
 *                      so every existing plan keeps today's behaviour),
 *                      is_public (false: no existing plan shows on the
 *                      marketing site or at sign-up until an admin turns it
 *                      on) and display_order. CHECKs: trial_days >= 0,
 *                      max_stores >= 1 when set, the other numbers >= 0.
 *
 *  users               selected_plan_id / selected_billing_cycle: the plan
 *                      chosen at sign-up, applied to the first store.
 *                      requires_plan_selection: a Google account made while a
 *                      plan is required, which must still pick one (false
 *                      for everyone who exists now). terms_accepted_at /
 *                      terms_version: the terms the person agreed to.
 *                      Active accounts with neither verification timestamp
 *                      are marked email-verified, so turning on sign-up
 *                      verification never locks one of them out.
 *
 *  funnel_creations    one row per funnel made (created or duplicated), kept
 *                      after the funnel is deleted (funnels are hard-deleted),
 *                      so the monthly funnel limit counts deleted ones too.
 *                      Backfilled from the funnels that exist.
 *
 *  plan_trials         one row per (person, plan) trial ever given: a trial
 *                      is once per plan per person. Backfilled from the
 *                      subscriptions that had one.
 *
 *  verification_codes  6-digit sign-up codes sent by email or SMS; only a
 *                      hash of the code is stored.
 *
 * users is the one large table touched: its new columns are nullable or have
 * a constant default (no table rewrite), its foreign key and CHECK are added
 * NOT VALID and validated afterwards (the scan does not block writes), its
 * index is built concurrently and the backfill runs in batches. The plans
 * table has a handful of rows; the new tables are new.
 *
 * `draft` for subscriptions.status is migration 127: a new value of an
 * existing enum, in a file of its own.
 */

async function constraintExists(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query('SELECT 1 FROM pg_constraint WHERE conname = $name', {
    bind: { name },
  });
  return rows.length > 0;
}

async function addConstraint(queryInterface, table, name, definition, { validateSeparately = false } = {}) {
  if (await constraintExists(queryInterface, name)) return;
  const q = queryInterface.sequelize;
  if (validateSeparately) {
    await q.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition} NOT VALID;`);
    await q.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name};`);
  } else {
    await q.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition};`);
  }
}

async function addColumnIfMissing(queryInterface, table, column, spec) {
  const description = await queryInterface.describeTable(table);
  if (!description[column]) await queryInterface.addColumn(table, column, spec);
}

const BACKFILL_BATCH = 5000;

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const q = queryInterface.sequelize;

    // --------------------------------------------------------------- plans
    await addColumnIfMissing(queryInterface, 'plans', 'max_stores', { type: DataTypes.INTEGER, allowNull: true });
    await addColumnIfMissing(queryInterface, 'plans', 'max_funnels_per_month', { type: DataTypes.INTEGER, allowNull: true });
    await addColumnIfMissing(queryInterface, 'plans', 'is_public', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await addColumnIfMissing(queryInterface, 'plans', 'display_order', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
    await addConstraint(queryInterface, 'plans', 'plans_trial_days_check', 'CHECK (trial_days >= 0)');
    await addConstraint(queryInterface, 'plans', 'plans_max_stores_check', 'CHECK (max_stores IS NULL OR max_stores >= 1)');
    await addConstraint(
      queryInterface,
      'plans',
      'plans_max_funnels_per_month_check',
      'CHECK (max_funnels_per_month IS NULL OR max_funnels_per_month >= 0)'
    );
    await addConstraint(queryInterface, 'plans', 'plans_display_order_check', 'CHECK (display_order >= 0)');

    // --------------------------------------------------------------- users
    await addColumnIfMissing(queryInterface, 'users', 'selected_plan_id', { type: DataTypes.UUID, allowNull: true });
    await addColumnIfMissing(queryInterface, 'users', 'selected_billing_cycle', { type: DataTypes.STRING(10), allowNull: true });
    await addColumnIfMissing(queryInterface, 'users', 'requires_plan_selection', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'users', 'terms_accepted_at', { type: DataTypes.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'users', 'terms_version', { type: DataTypes.STRING(40), allowNull: true });
    await addConstraint(
      queryInterface,
      'users',
      'users_selected_plan_id_fkey',
      'FOREIGN KEY (selected_plan_id) REFERENCES plans(id) ON DELETE SET NULL',
      { validateSeparately: true }
    );
    await addConstraint(
      queryInterface,
      'users',
      'users_selected_billing_cycle_check',
      "CHECK (selected_billing_cycle IS NULL OR selected_billing_cycle IN ('monthly', 'yearly'))",
      { validateSeparately: true }
    );
    // Lets a plan's deletion (ON DELETE SET NULL) find the few rows naming it.
    await createIndexConcurrently(queryInterface, {
      name: 'users_selected_plan_id_idx',
      table: 'users',
      definition: '(selected_plan_id) WHERE selected_plan_id IS NOT NULL',
    });

    // Accounts that can sign in today stay able to: mark them email-verified.
    for (;;) {
      const [updated] = await q.query(
        `UPDATE users SET email_verified_at = NOW()
          WHERE id IN (SELECT id FROM users
                        WHERE status = 'active' AND email_verified_at IS NULL AND phone_verified_at IS NULL
                        LIMIT ${BACKFILL_BATCH})
          RETURNING id`
      );
      if (updated.length < BACKFILL_BATCH) break;
    }

    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));

    // ----------------------------------------------------- funnel_creations
    if (!tables.includes('funnel_creations')) {
      await queryInterface.createTable('funnel_creations', {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
        // No foreign key: the row outlives the funnel.
        funnel_id: { type: DataTypes.UUID, allowNull: true },
        source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'create' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await q.query(
        `ALTER TABLE funnel_creations
           ADD CONSTRAINT funnel_creations_source_check CHECK (source IN ('create', 'duplicate', 'backfill'))`
      );
      await queryInterface.addIndex('funnel_creations', ['workspace_id', 'created_at'], {
        name: 'funnel_creations_workspace_created_idx',
      });
      await q.query(
        `INSERT INTO funnel_creations (id, workspace_id, funnel_id, source, created_at)
         SELECT md5('funnel_creation:' || f.id::text)::uuid, f.workspace_id, f.id, 'backfill', f.created_at
           FROM funnels f
         ON CONFLICT (id) DO NOTHING`
      );
    }

    // ----------------------------------------------------------- plan_trials
    if (!tables.includes('plan_trials')) {
      await queryInterface.createTable('plan_trials', {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
        plan_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'plans', key: 'id' }, onDelete: 'CASCADE' },
        workspace_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'SET NULL' },
        source: { type: DataTypes.STRING(20), allowNull: false },
        started_at: { type: DataTypes.DATE, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await q.query(
        `ALTER TABLE plan_trials
           ADD CONSTRAINT plan_trials_source_check CHECK (source IN ('store_created', 'start_trial', 'backfill'))`
      );
      await queryInterface.addIndex('plan_trials', ['user_id', 'plan_id'], { name: 'plan_trials_user_plan_unique', unique: true });
      await q.query(
        `INSERT INTO plan_trials (id, user_id, plan_id, workspace_id, source, started_at, created_at)
         SELECT md5('plan_trial:' || s.id::text)::uuid, w.owner_user_id, s.plan_id, w.id, 'backfill',
                s.current_period_start, NOW()
           FROM subscriptions s
           JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.plan_id IS NOT NULL AND s.trial_ends_at IS NOT NULL AND w.owner_user_id IS NOT NULL
         ON CONFLICT DO NOTHING`
      );
    }

    // ---------------------------------------------------- verification_codes
    if (!tables.includes('verification_codes')) {
      await queryInterface.createTable('verification_codes', {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
        channel: { type: DataTypes.STRING(10), allowNull: false },
        // The email address or the normalised phone number the code went to.
        target: { type: DataTypes.STRING(255), allowNull: false },
        code_hash: { type: DataTypes.STRING(128), allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        consumed_at: { type: DataTypes.DATE, allowNull: true },
        // Set when a newer code replaces this one.
        superseded_at: { type: DataTypes.DATE, allowNull: true },
        request_ip: { type: DataTypes.STRING(64), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await q.query(
        `ALTER TABLE verification_codes
           ADD CONSTRAINT verification_codes_channel_check CHECK (channel IN ('email', 'sms')),
           ADD CONSTRAINT verification_codes_attempts_check CHECK (attempts >= 0)`
      );
      await queryInterface.addIndex('verification_codes', ['user_id', 'created_at'], { name: 'verification_codes_user_created_idx' });
      await queryInterface.addIndex('verification_codes', ['target', 'created_at'], { name: 'verification_codes_target_created_idx' });
      await queryInterface.addIndex('verification_codes', ['request_ip', 'created_at'], { name: 'verification_codes_ip_created_idx' });
    }
  },

  down: async (queryInterface) => {
    const q = queryInterface.sequelize;
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));
    if (tables.includes('verification_codes')) await queryInterface.dropTable('verification_codes');
    if (tables.includes('plan_trials')) await queryInterface.dropTable('plan_trials');
    if (tables.includes('funnel_creations')) await queryInterface.dropTable('funnel_creations');

    // The email_verified_at backfill is kept: it cannot be told apart from a
    // real verification, and keeping it locks nobody out.
    await dropIndexConcurrently(queryInterface, 'users_selected_plan_id_idx');
    await q.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_selected_billing_cycle_check;');
    await q.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_selected_plan_id_fkey;');
    const users = await queryInterface.describeTable('users');
    for (const column of ['terms_version', 'terms_accepted_at', 'requires_plan_selection', 'selected_billing_cycle', 'selected_plan_id']) {
      if (users[column]) await queryInterface.removeColumn('users', column);
    }

    for (const name of ['plans_display_order_check', 'plans_max_funnels_per_month_check', 'plans_max_stores_check', 'plans_trial_days_check']) {
      await q.query(`ALTER TABLE plans DROP CONSTRAINT IF EXISTS ${name};`);
    }
    const plans = await queryInterface.describeTable('plans');
    for (const column of ['display_order', 'is_public', 'max_funnels_per_month', 'max_stores']) {
      if (plans[column]) await queryInterface.removeColumn('plans', column);
    }
  },
};
