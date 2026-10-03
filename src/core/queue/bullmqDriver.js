'use strict';

const logger = require('../utils/logger');
const { QUEUE_NAMES, policyFor, isPermanent } = require('./queues');

/**
 * The queue on BullMQ + Redis — chosen by index.js when REDIS_URL is set.
 * Same methods as postgresDriver.js. `bullmq` is required lazily so a server
 * without Redis never loads it.
 *
 * Redis cannot join a database transaction: `add({ transaction })` waits for
 * the commit and then enqueues. Events do not depend on that — they are
 * written to domain_events inside the transaction and the dispatcher retries
 * until the queue has them.
 */

const CRON_QUEUE = 'cron';

let bullmq = null;
let connection = null;
const queues = new Map(); // name → Queue
const workers = [];
const handlers = new Map();
const schedules = new Map();

function lib() {
  if (!bullmq) {
    try {
      // eslint-disable-next-line global-require
      bullmq = require('bullmq');
    } catch (err) {
      throw new Error('REDIS_URL is set but the "bullmq" package is not installed (npm install bullmq)');
    }
  }
  return bullmq;
}

function connect(redisUrl) {
  if (!connection) {
    const url = new URL(redisUrl);
    connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      // BullMQ's blocking workers require this.
      maxRetriesPerRequest: null,
    };
  }
  return connection;
}

function queueOf(name) {
  if (!queues.has(name)) {
    const { Queue } = lib();
    queues.set(name, new Queue(name, { connection: connect(process.env.REDIS_URL) }));
  }
  return queues.get(name);
}

async function add(queue, name, payload = {}, { delayMs = 0, dedupeKey = null, workspaceId = null, transaction = null } = {}) {
  const policy = policyFor(queue);
  const enqueue = async () => {
    const job = await queueOf(queue).add(
      name,
      { ...payload, __workspaceId: workspaceId },
      {
        delay: Math.max(0, Math.round(delayMs)),
        attempts: policy.delays.length + 1,
        backoff: { type: 'zimos' },
        // BullMQ ignores a second add with the same id: that is the dedupe.
        jobId: dedupeKey ? dedupeKey.replace(/:/g, '_') : undefined,
        removeOnComplete: { age: 3 * 24 * 3600, count: 5000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      }
    );
    return { id: job.id, queued: true };
  };
  if (transaction) {
    transaction.afterCommit(() => enqueue().catch((err) => logger.error(`[queue] could not enqueue ${queue}/${name}: ${err.message}`)));
    return { id: null, queued: true };
  }
  return enqueue();
}

function process_(queue, handle) {
  policyFor(queue);
  handlers.set(queue, handle);
}

function every(name, everyMs, handle) {
  schedules.set(name, { everyMs, handle });
}

async function start({ concurrency = 10 } = {}) {
  const { Worker, UnrecoverableError } = lib();
  const conn = connect(process.env.REDIS_URL);

  for (const [queue, handle] of handlers) {
    const policy = policyFor(queue);
    const worker = new Worker(
      queue,
      async (job) => {
        const { __workspaceId: workspaceId, ...payload } = job.data || {};
        try {
          await handle({ id: job.id, queue, name: job.name, payload, attempts: job.attemptsMade + 1, maxAttempts: job.opts.attempts || 1, workspaceId: workspaceId || null });
        } catch (err) {
          if (isPermanent(queue, err)) throw new UnrecoverableError(err.message);
          throw err;
        }
      },
      {
        connection: conn,
        concurrency,
        settings: {
          backoffStrategy: (attemptsMade) => policy.delays[attemptsMade - 1] ?? policy.delays[policy.delays.length - 1] ?? 0,
        },
      }
    );
    worker.on('failed', (job, err) => logger.warn(`[queue] ${queue}/${job ? job.name : '?'} failed: ${err.message}`));
    workers.push(worker);
  }

  if (schedules.size > 0) {
    const cron = queueOf(CRON_QUEUE);
    for (const [name, schedule] of schedules) {
      await cron.upsertJobScheduler(name, { every: schedule.everyMs }, { name, opts: { removeOnComplete: 50, removeOnFail: 200 } });
    }
    const worker = new Worker(
      CRON_QUEUE,
      async (job) => {
        const schedule = schedules.get(job.name);
        if (schedule) await schedule.handle();
      },
      { connection: conn, concurrency: 1 }
    );
    worker.on('failed', (job, err) => logger.error(`[queue] schedule ${job ? job.name : '?'} failed: ${err.message}`));
    workers.push(worker);
  }
}

async function stop() {
  await Promise.all(workers.map((worker) => worker.close()));
  workers.length = 0;
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

async function stats() {
  const result = [];
  for (const name of QUEUE_NAMES) {
    const counts = await queueOf(name).getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
    result.push({
      name,
      pending: (counts.waiting || 0) + (counts.delayed || 0),
      active: counts.active || 0,
      failed: counts.failed || 0,
      completedLastDay: counts.completed || 0,
      oldestPendingAt: null,
    });
  }
  const schedulers = await queueOf(CRON_QUEUE).getJobSchedulers(0, 200, true);
  return {
    driver: 'bullmq',
    queues: result,
    schedules: schedulers.map((s) => ({
      name: s.key || s.name,
      everyMs: Number(s.every) || null,
      nextRunAt: s.next ? new Date(s.next) : null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
    })),
  };
}

async function listJobs({ status = 'failed', queue = null, limit = 50 } = {}) {
  const names = queue ? [queue] : QUEUE_NAMES;
  const state = status === 'pending' ? ['waiting', 'delayed'] : [status];
  const out = [];
  for (const name of names) {
    const jobs = await queueOf(name).getJobs(state, 0, limit - 1);
    for (const job of jobs) {
      out.push({
        id: `${name}:${job.id}`,
        queue: name,
        name: job.name,
        status,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts || 1,
        workspaceId: (job.data && job.data.__workspaceId) || null,
        lastError: job.failedReason || null,
        runAt: new Date(job.timestamp + (job.opts.delay || 0)),
        createdAt: new Date(job.timestamp),
        finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      });
    }
  }
  return out.slice(0, limit);
}

async function retryJob(id) {
  const [queue, ...rest] = String(id).split(':');
  if (!QUEUE_NAMES.includes(queue)) return false;
  const job = await queueOf(queue).getJob(rest.join(':'));
  if (!job) return false;
  await job.retry();
  return true;
}

// BullMQ removes old jobs itself (removeOnComplete / removeOnFail above).
async function prune() {
  return { removed: 0 };
}

module.exports = {
  name: 'bullmq',
  transactional: false,
  add,
  process: process_,
  every,
  start,
  stop,
  stats,
  listJobs,
  retryJob,
  prune,
};
