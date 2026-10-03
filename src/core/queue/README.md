# Background work: outbox, queue, worker

Anything that happens *after* the response — messages, pixels, webhooks,
imports, courier calls — goes through here instead of a fire-and-forget
`transaction.afterCommit`.

```
business change ──(same transaction)──► domain_events
                                             │  dispatcher (worker, every second)
                                             ▼
                                   queue "events" / dispatch
                                             │  one job per consumer
                                             ▼
                    notifications · pixels · webhooks · carriers · io · ai
```

## Recording an event

```js
const outbox = require('../../core/outbox/outbox');

await outbox.record(transaction, 'order.created', { workspaceId, orderId: order.id });
```

- `transaction` is the transaction of the change (`null` if there is none).
- The payload must carry `workspaceId`; put ids in it, not whole objects —
  consumers read the current rows.
- Event names use dots (`order.status_changed`), see the catalogue in SPEC §3.2.
- The aggregate is inferred from the name: `order.*` + `orderId` → `order/<id>`.
  Pass `{ aggregateType, aggregateId }` as a fourth argument to override.
- Recording never fails the caller: the insert runs in a savepoint and, if it
  cannot be written, the consumers run right after the commit instead.

## Reacting to events, queuing jobs, repeatable jobs

Put a `jobs.js` in your module (`src/modules/<module>/jobs.js`). It is found by
its name — there is no registry file to edit.

```js
module.exports = {
  consumers: [
    {
      name: 'sheets_sync',              // unique
      queue: 'default',                 // which queue's retry policy applies
      events: ['order.created', 'order.status_changed'], // or '*'
      handle: async (event) => {
        // event: { id, type, workspaceId, aggregateType, aggregateId, payload, occurredAt }
      },
    },
  ],
  processors: [
    { queue: 'io', name: 'orders.export', handle: async (job) => { /* job.payload, job.attempts, job.workspaceId */ } },
  ],
  schedules: [
    { name: 'feeds.rebuild', everyMs: 6 * 60 * 60 * 1000, handle: async () => {} },
  ],
};
```

Queue a job from anywhere:

```js
const queue = require('../../core/queue');

await queue.add('io', 'orders.export', { exportId }, { transaction, workspaceId, delayMs: 0, dedupeKey: `export:${exportId}` });
```

A handler that throws is retried with the queue's policy (`queues.js`):

| Queue | Attempts | Waits |
| --- | --- | --- |
| `events` | 5 | 5s, 10s, 20s, 40s |
| `notifications` | 5 | 15s … 2m; a 4xx (except 408/429) is not retried |
| `pixels` | 3 | 30s, 60s |
| `webhooks` | 7 | 1m, 5m, 30m, 2h, 6h, 24h |
| `carriers` | 5 | 30s … 4m |
| `io` | 1 | — |
| `ai` | 2 | 30s |
| `default` | 3 | 10s, 20s |

Throw an error with `err.permanent = true` to stop retrying. Handlers must be
safe to run twice (at-least-once delivery).

## Running it

- **In the API process** (default): `WORKER_IN_PROCESS` is on, nothing else to
  start.
- **As its own service**: `npm run worker` (`src/worker.js`) and
  `WORKER_IN_PROCESS=false` on the API. Several workers may run together.
- **Under `NODE_ENV=test`** there is no worker: events and jobs run inline —
  after the commit when a transaction is given — and the hook waits for them.

## Drivers

| | Chosen when | Jobs live in | `add({ transaction })` |
| --- | --- | --- | --- |
| `postgresDriver.js` | `REDIS_URL` is not set | `queue_jobs`, `queue_schedules` | joins the transaction |
| `bullmqDriver.js` | `REDIS_URL` is set | Redis | queued after the commit |

Both expose `add, process, every, start, stop, stats, listJobs, retryJob,
prune`. The BullMQ driver needs the `bullmq` package (`npm install bullmq`);
it could not be installed or exercised on the build machine (no Redis, no
registry access), so treat it as written to the BullMQ v5 API but unproven.

Repeatable jobs registered today: `webhooks.retry` (1m), `payments.sweep` (5m),
`billing.sweep_payments` (10m), `carriers.poll_status` (30m),
`billing.expire_trials` (1h), `uploads.sweep` (1h), `queue.prune` and
`outbox.prune` (6h).
