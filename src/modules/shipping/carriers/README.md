# Courier adapters — the contract

One file per courier, built with `defineAdapter()` (`adapterContract.js`) and
registered in `index.js`. The routes, booking, webhook, poller and order
timeline are courier-agnostic: adding a courier is a new file and one line in
`REGISTERED`. This is the contract the integrations team writes against.

## Registration and rollout

| Adapter | Who sees it |
| --- | --- |
| listed in `CARRIERS_ENABLED` | every store |
| listed in `CARRIERS_BETA` | stores whose slug is in `CARRIERS_BETA_WORKSPACES` |
| `sandbox` | every store outside production; in production only with `CARRIERS_SANDBOX=true`, and only stores whose FeatureFlag `sandbox_integrations` is on |
| anything else | nobody — its name is free for manual shipments |

`manual` is not an adapter: a shipment the merchant booked elsewhere and
typed the waybill of. Any `carrierCode` without an adapter behaves the same.

## Descriptive fields

| Field | Meaning |
| --- | --- |
| `code` | `[a-z0-9_-]{1,50}`, never `manual` |
| `name`, `nameAliases` | display name; other names a merchant may type for it |
| `capabilities` | see below |
| `credentialFields` | `[{ key, label, secret }]` — the connect form |
| `settingFields` | `[{ key, label, options? }]` |
| `credentialsSchema`, `settingsSchema` | Joi schemas for what the form sends |
| `pollIntervalMinutes` | default 60 |

## Capabilities (all optional)

| Capability | Values | Needs |
| --- | --- | --- |
| `cancel` | `api` (default) / `manual` | `cancelShipment()` for `api` |
| `label` | boolean | `getLabel()` |
| `webhook` | `per_shipment` / `account` / `none` | `parseWebhook()` unless `none` |
| `webhookRefetch` | default `true`: the webhook only names the parcel and its status is re-read with `getShipment`. `false` trusts the payload | `verifyWebhook()` when `false` |
| `polling` | the carrier-sync job may poll open shipments | — |
| `bulkStatus` | `getShipments()` reads many in one call | `getShipments()` |
| `addressLevels` | names of the courier's address levels, top first. `['city', 'district']` keeps the city/district API | `listCities()` or `listAddressTree()` for city/district; `listAddressTree()` otherwise |
| `typedAddressNames` | a booking may send typed names when the courier refuses its address list | `typedAddress()` |

A capability claimed without the function behind it throws at require time.

## Functions

Every function gets the **decrypted** credentials first. Never log them.
Amounts (`cod`, `goodsValue`) are in **our** minor units; the adapter converts.

| Function | Returns |
| --- | --- |
| `verifyCredentials(creds, settings)` | `{ pickupLocations?: [{ id, name }] }`; throws on bad credentials |
| `resolvePackage(settings, tier)` (optional) | the package to book for a weight tier, passed back as `package`; 422 `CARRIER_TIER_UNMAPPED` when the settings map tiers but not this one |
| `listCities(creds)` | `[{ id, name, nameAr, dropOffAvailable, districts: [{ id, name, nameAr, zoneId, zoneName, zoneNameAr, dropOffAvailable }] }]` |
| `listAddressTree(creds)` | `[{ id, name, nameAr, dropOffAvailable?, aliases?, meta?, children? }]`, as deep as `addressLevels`; leaves are bookable |
| `createShipment(creds, { order, address, cod, goodsValue, itemsCount, description, notes, carrierSettings, package, webhookUrl })` | `{ trackingNumber, carrierShipmentId, trackingUrl?, labelUrl?, raw }` — `raw` is stored on the shipment: whitelist, no personal data, no secrets. Never retried |
| `getShipment(creds, trackingNumber)` | `{ status, carrierStatus, raw }` — `status` is ours (`created`, `picked_up`, `in_transit`, `out_for_delivery`, `delivered`, `failed`, `returned`, `cancelled`) or `null` for a courier state we cannot act on (log it) |
| `getShipments(creds, trackingNumbers)` | `Map(trackingNumber → getShipment result)`; a parcel the courier did not answer for is absent |
| `cancelShipment(creds, trackingNumber, { carrierShipmentId })` | resolves, or throws when refused |
| `isCancelSettled(carrierStatus)` (optional) | whether a courier state leaves a cancel nothing to stop |
| `getLabel(creds, trackingNumber, settings)` | a PDF `Buffer` |
| `parseWebhook(req)` | `{ ref, status?, carrierStatus? }` or `null` |
| `verifyWebhook(req, { account, credentials })` (optional) | boolean |
| `isSandbox(creds)` (optional) | the credentials point at the courier's own test environment |

`address` for `createShipment` is `{ path: [{ id, name, nameAr, level, meta }], firstLine, secondLine }`,
plus `cityId`, `cityName`, `districtId`, `zoneId` for city/district couriers.

## Errors

Throw from `carrierErrors.js`:

- `CarrierAuthError` — the courier rejected the credentials (422, the account is marked invalid);
- `CarrierPermissionError` — the key lacks a scope (422);
- `CarrierError` — anything else (424).

Messages go through `sanitizeCarrierMessage` (no secrets). All HTTP goes
through `carrierHttp.request`: creates without retry, reads with retry.

## The sandbox courier (`sandbox.js`)

The whole contract with no network, for building and testing features:

- connect it with any key of 8+ characters; one pickup location;
- the address list has two levels, city > district: Egypt's governorates and the
  platform's cities under each (`geo_regions`). North Coast towns sit under
  Alexandria or Matrouh, as on most real couriers' lists;
- waybills are `SBX-` + 8 digits; no label (the store's own waybill PDF is used);
- the courier's side of a parcel lives on the shipment (`carrier_response.sandboxStatus`),
  starting at `created`; it can be cancelled while `created`;
- it moves only when someone calls

  ```
  POST /api/v1/dev/sandbox/shipments/:shipmentId/advance   { "to"?: "delivered" | "failed" | "returned" | … }
  Authorization: Bearer <staff token with orders.manage on that store>
  ```

  which walks `created → picked_up → in_transit → out_for_delivery → delivered`
  (or jumps to `to`) and then syncs the shipment like the poller does, so the
  order's stage, its events (`order.shipped`, `order.delivered`,
  `order.returned`…) and the automations all follow.

## Adding a courier

1. A new file here with `defineAdapter({...})`, built against this contract.
2. One line in `REGISTERED` (`index.js`).
3. Ship it in `CARRIERS_BETA` with a test store in `CARRIERS_BETA_WORKSPACES`,
   then move it to `CARRIERS_ENABLED`.

## Areas map (`../carrierRegionMap.js`)

An order's free-text province and city are first read back to a place of the
platform's list (`geo_regions`, `modules/geo/geoRegions.js`), and the place is
looked up in `carrier_region_map`: the store's own choice, else the one found
by name matching (shared by every store, refreshed daily when a store opens
the courier's Areas screen). Only when the place has no mapping, or the mapping
names a node the courier no longer lists, does booking fall back to matching
the order's own text, as before. An adapter needs nothing for this: its
`listCities` / `listAddressTree` is what the places are matched against.
