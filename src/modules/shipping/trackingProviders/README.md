# Tracking providers (manual and imported waybills)

Item 387. A shipment the merchant created by hand (any courier name, a
waybill typed in) or that the tracking CSV import created is not booked
through a connected courier account, so no courier webhook or poll ever
updates it. When the store switches tracking on, these shipments are followed
through a **tracking provider** — a service that reads many couriers' tracking
pages by waybill number.

Courier-booked shipments (`carrierResponse.carrierShipmentId` present,
`carrierShipmentService.isCarrierBooked`) are never touched here: they keep
the courier's webhooks and `carriers.poll_status`.

## The store setting

`workspaces.settings.tracking_provider = { enabled, provider }`

| Endpoint | Permission | |
|---|---|---|
| `GET /api/v1/workspaces/:ws/shipping/tracking-provider` | shipping.manage | `{ trackingProvider: { enabled, provider }, providers: [{ code, name, sandbox, available }], polling: { intervalMinutes, maxAgeDays } }` |
| `PUT /api/v1/workspaces/:ws/shipping/tracking-provider` | shipping.manage | body `{ enabled: boolean, provider?: 'sandbox' \| 'aftership' \| null }`; 422 when `enabled` without a provider, or a provider this server/store can't use; audited `shipping.tracking_provider_update` |

Switching off keeps the chosen provider. Off means nothing is read: the job
skips the store and the sync button answers as before (409
`SHIPMENT_NOT_CARRIER_MANAGED`).

## What happens to a shipment

`manualTracking.js`:

1. **Register** the waybill with the provider the first time (or when the
   waybill or the provider changed). The courier is detected from the courier
   name or the number's shape (`courierDetect.js`) and passed to providers
   that want it.
2. **Fetch** its checkpoints `{ key, at, status, code, description, location }`.
3. **Apply** under the shipment's row lock:
   - every checkpoint not seen before becomes a `shipment_events` row at the
     checkpoint's own time (trigger `tracking_poll` or `tracking_sync`);
   - the status moves only through checkpoints dated after the last one
     applied, and never backwards: created < picked up < in transit < out for
     delivery = failed attempt < delivered < returned; delivered, returned and
     cancelled are final (only delivered → returned is allowed), the same rule
     courier reports follow;
   - the move goes through `transitionShipment` like a courier's report
     (`metadata.source: 'carrier', via: 'tracking_provider'`): shipped and
     delivered stamps, the order's fulfillment and stage history, the audit
     row, and the outbox event — `order.delivered` once, when it first becomes
     delivered (COD settlements then see a delivered parcel as they do for a
     courier's).

Provider statuses and ours:

| Provider status | Shipment status |
|---|---|
| `picked_up` | `picked_up` |
| `in_transit` | `in_transit` |
| `out_for_delivery` | `out_for_delivery` |
| `failed_attempt` | `failed` |
| `delivered` | `delivered` |
| `returned` | `returned` |
| `info_received`, `returning`, `exception` | history only |

## The job

`shipments.track_manual` (shipping/jobs.js), every 30 minutes. It claims live
manual shipments with a waybill in stores with the setting on, skipping:
final ones (delivered, returned, cancelled), ones created more than
`TRACKING_POLL_MAX_AGE_DAYS` ago, the import's placeholder waybill
`IMP-<order number>`, and courier bookings. Claimed rows get a 10-minute lease
(`FOR UPDATE SKIP LOCKED`) so overlapping runs don't read the same one.

| Env | Default | |
|---|---|---|
| `TRACKING_POLL_INTERVAL_MINUTES` | 60 | between two reads of one shipment |
| `TRACKING_POLL_MAX_AGE_DAYS` | 45 | older shipments are not read |
| `TRACKING_POLL_PER_STORE` | 50 | reads per store per run |
| `TRACKING_POLL_BATCH` | 500 | reads per run |

A failed read backs off: interval × 2^failures, at most a day (a refusal
that won't fix itself — bad key, number rejected — waits a day). A waybill the
merchant types again is read on the next run, unless it is the very number
that is failing. Once final, a shipment is never read again.

`POST /orders/:orderId/shipments/:shipmentId/sync` reads a manual shipment at
once when the store's provider is on: `{ shipment, changed, carrierStatus,
tracking: { provider, newCheckpoints } }`; 409 `SHIPMENT_NO_WAYBILL` without a
real waybill; 502 `TRACKING_PROVIDER_FAILED` when the provider can't be read.

## The contract (`providerContract.js`)

```js
defineProvider({
  code: 'myprovider',
  name: 'My Provider',
  configured: () => Boolean(process.env.MYPROVIDER_API_KEY),
  // Follow a number; safe to call again for one already followed.
  async register({ waybill, courier }) { return { ref, courier /* provider's own courier code, optional */ }; },
  // Its checkpoints, any order. `status` from PROVIDER_STATUSES or null.
  async fetch({ waybill, courier, ref, registeredAt }) {
    return { checkpoints: [{ key, at: Date, status, code, description, location }], courier };
  },
});
```

Throw `TrackingProviderError(message, { retryable })` on failure; set
`err.unregistered = true` when the provider no longer knows `ref` (it is
registered again next time). Never put the API key in an error message or a
log line. Add the file to `PROVIDERS` in `index.js`.

## Providers

### `sandbox`

No network; the history follows from the waybill. Outside production for
every store; in production only with `TRACKING_SANDBOX=true` and the store's
FeatureFlag `sandbox_integrations`.

- `TRK-` and steps, oldest first: `IR` info received, `PU` picked up, `IT` in
  transit, `OD` out for delivery, `FA` failed attempt, `DL` delivered, `RS`
  returning, `RT` returned, `EX` exception. `TRK-IT-OD-DL` is delivered.
- `OLD<step>`: that step dated before all the others and reported late (from
  `TRACKING_SANDBOX_LATE_SECONDS`, default 30, after registration):
  `TRK-IT-OD-OLDIT` shows the late scan in the history and stays out for
  delivery.
- `TRK-ERR` fails (backoff); `TRK-NONE` has nothing yet.
- Any other number by its last digit: 0–1 in transit, 2–3 out for delivery,
  4–6 delivered, 7 failed attempt, 8 returned, 9 nothing yet; no digit: in
  transit.

### `aftership`

[AfterShip Tracking API](https://www.aftership.com/docs/tracking), version
`2026-07`, as its own Node SDK (`@aftership/tracking-sdk` 17.0.0) calls it:

- `POST /tracking/2026-07/trackings` `{ tracking_number, slug? }` → `data.id`;
  meta code `4003` (already tracked) → `GET /tracking/2026-07/trackings?tracking_numbers=…&slug=…`.
- `GET /tracking/2026-07/trackings/:id` → `data.checkpoints[]`
  (`checkpoint_time`, `created_at`, `tag`, `subtag`, `message`, `location`,
  `hash`); 404 / `4004` → registered again.
- Header `as-api-key: $AFTERSHIP_API_KEY` (the platform's key, from the
  environment only; never logged or returned). `AFTERSHIP_API_BASE` points it
  at a stand-in.
- Tags: `InfoReceived` → info received, `InTransit` → in transit,
  `OutForDelivery` and `AvailableForPickup` → out for delivery, `AttemptFail` →
  failed attempt, `Delivered` → delivered, `Exception` + subtag
  `Exception_011` → returned, `Exception_010` → returning, other exceptions,
  `Pending` and `Expired` → history only.
- Times: `checkpoint_time` when it carries an offset; otherwise `created_at`
  (UTC), since a bare `checkpoint_time` is in the checkpoint's local zone.
- Courier: the slug is sent for Aramex, DHL, FedEx and UPS (detected from the
  courier name, or a `1Z…` UPS number); for any other courier AfterShip detects
  it from the number.

AfterShip's own plan limits and prices apply to the platform's account; none
are in this code.

### Adding 17TRACK or another

Write `seventeentrack.js` on the contract above (register the number, then
read its events), map its statuses to `PROVIDER_STATUSES`, add it to
`PROVIDERS` in `index.js`, and document its env key here. No other file
changes: the setting, the job and the sync button take any provider.
