'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Background work (SPEC §3.1–3.3).
 *
 * domain_events: the outbox. A business change writes its event here inside
 * its own transaction (core/outbox/outbox.js#record); the worker's dispatcher
 * picks up rows with `dispatched_at IS NULL` and hands them to the queue.
 *
 * queue_jobs: the queue's jobs (core/queue/postgresDriver.js). One row per job, claimed with
 * FOR UPDATE SKIP LOCKED, retried with the queue's backoff.
 *
 * queue_schedules: repeatable jobs ("cron") and when each last ran.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('NOW()');
    const uuid = { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') };

    await queryInterface.createTable('domain_events', {
      id: uuid,
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      type: { type: DataTypes.STRING(80), allowNull: false },
      aggregate_type: { type: DataTypes.STRING(60), allowNull: true },
      aggregate_id: { type: DataTypes.STRING(80), allowNull: true },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      dispatched_at: { type: DataTypes.DATE, allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    });
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS domain_events_pending_idx ON domain_events (occurred_at) WHERE dispatched_at IS NULL');
    await queryInterface.addIndex('domain_events', ['workspace_id', 'type', 'occurred_at'], {
      name: 'domain_events_workspace_type_idx',
    });
    await queryInterface.addIndex('domain_events', ['aggregate_type', 'aggregate_id'], {
      name: 'domain_events_aggregate_idx',
    });

    await queryInterface.createTable('queue_jobs', {
      id: uuid,
      queue: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // pending → active → completed | failed (a retry goes back to pending).
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      run_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      locked_at: { type: DataTypes.DATE, allowNull: true },
      locked_by: { type: DataTypes.STRING(80), allowNull: true },
      last_error: { type: DataTypes.TEXT, allowNull: true },
      dedupe_key: { type: DataTypes.STRING(200), allowNull: true },
      workspace_id: { type: DataTypes.UUID, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    });
    await queryInterface.sequelize.query("CREATE INDEX IF NOT EXISTS queue_jobs_due_idx ON queue_jobs (queue, run_at) WHERE status = 'pending'");
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_dedupe_idx ON queue_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL');
    await queryInterface.addIndex('queue_jobs', ['status', 'queue', 'updated_at'], { name: 'queue_jobs_status_idx' });

    await queryInterface.createTable('queue_schedules', {
      name: { type: DataTypes.STRING(120), primaryKey: true, allowNull: false },
      every_ms: { type: DataTypes.BIGINT, allowNull: false },
      next_run_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      last_run_at: { type: DataTypes.DATE, allowNull: true },
      last_status: { type: DataTypes.STRING(20), allowNull: true },
      last_error: { type: DataTypes.TEXT, allowNull: true },
      last_duration_ms: { type: DataTypes.INTEGER, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('queue_schedules');
    await queryInterface.dropTable('queue_jobs');
    await queryInterface.dropTable('domain_events');
  },
};
