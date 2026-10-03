# Lane 7 — Platform core: infrastructure, API, team, account

## Done
- [x] 1. Outbox + queue + worker — backend only — created an order on :4107: `domain_events` row dispatched, `events/dispatch` → `consume:automations`, `consume:server_pixels`, `consume:merchant_notifications` all completed, an `automation_runs` row and the bell notification appeared; 8 repeatable jobs registered in `queue_schedules`, `webhooks.retry` ran ok. How to use it: `src/core/queue/README.md`.

## Next
- [ ] 2. Security fixes of §3.4 that still apply (check each against the code first)
- [ ] 3. Public API (§16.2): products, categories, customers, discounts, shipping areas, order create/notes/tracking, scopes, rate-limit headers, public OpenAPI
- [ ] 4. Webhooks (§16.1): remaining topics, per-endpoint filter, auto-disable after 3 days, resend order to webhook
- [ ] 5. App install link (§16.3); apps catalogue and `AppsPage` (§16.6); `DropshipProvider` interface + sandbox + README
- [ ] 6. Team (§17.1): invite dialog with section checkboxes, `fulfillment` role; sessions screen; two-factor on login; activity log screen; support access grant (§17.2)
- [ ] 7. `requirePlanLimit(key)` + `usage_counters` (§17.4, allowed part)
- [ ] 8. Platform-admin screens still missing (§17.5); queue status screen
- [ ] 9. GitHub Actions workflows for typecheck and build (§3.5)

## Decisions
- 2026-10-03 Worker runs inside the API process by default (`WORKER_IN_PROCESS`, like `WEBHOOKS_IN_PROCESS`), because today's deploy starts only the API; `npm run worker` + `WORKER_IN_PROCESS=false` splits it out (docker-compose does).
- 2026-10-03 Modules declare consumers/processors/schedules in their own `src/modules/<m>/jobs.js`, auto-discovered — no shared registry file for lanes to collide on.
- 2026-10-03 `outbox.record` writes inside a savepoint and falls back to running consumers after commit if the insert fails, so a lane that has not migrated yet never loses an order to the outbox.
- 2026-10-03 Under `NODE_ENV=test` events and jobs run inline after commit (same behaviour the old `emit` had), so Ziad's suite keeps seeing automation runs.
- 2026-10-03 The existing cron scripts (carrier sync, payment sweeps, trial check, upload sweep, webhook pass) are also registered as repeatable jobs; the scripts stay and running both is safe (each claims with row locks).
- 2026-10-03 Migration numbers used: 285.

## Blocked
- BullMQ driver: `npm install bullmq` fails on this machine (no registry access) and there is no Redis, so `src/core/queue/bullmqDriver.js` is written but never run, and `bullmq` is not in package.json. Whoever deploys with `REDIS_URL` must `npm install bullmq` and try it.

## Handoff
Branch `lane-7` in both repos. Item 1 landed. Manual-check helpers are not in the repo (they lived in the chat's scratchpad): log in as demo@zimos.test on :4107 and query `zimos_lane_7` with `pg`.
