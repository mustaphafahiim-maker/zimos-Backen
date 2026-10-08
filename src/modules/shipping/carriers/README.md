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
| `countries` | ISO codes it delivers to, default `['EG']`; the carriers screen filters by it |

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
| `returnPickup` | the courier collects a returned parcel from the shopper and brings it back (item 372) | `createReturnPickup()` |
| `returnPickupStatus` | the pickup's state is read back from the courier (item 396) | `returnPickup` + `getReturnPickup()` |
| `returnPickupCancel` | the pickup can be cancelled at the courier (item 396) | `returnPickup` + `cancelReturnPickup()` |

A capability claimed without the function behind it throws at require time.

## Functions

Every function gets the **decrypted** credentials first. Never log them.
Amounts (`cod`, `goodsValue`) are in **our** minor units; the adapter converts. For a parcel that carries part of the order (item 375, `shipping/partialShipments.js`), `cod`, `goodsValue`, `itemsCount` and `description` describe that parcel only; read them from the input, never from `order`.

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
| `createReturnPickup(creds, { order, returnRequest, address, itemsCount, description, notes, carrierSettings, webhookUrl, originalTrackingNumber })` (`returnPickup`) | `{ trackingNumber, carrierShipmentId, reference?, trackingUrl?, labelUrl?, raw }` — a pickup at the order's address (`address` as for `createShipment`), nothing to collect in cash. `originalTrackingNumber` is the order's own delivery with this courier, or null. Stored on the return (`return_requests.pickup`), not as a shipment. Never retried |
| `getReturnPickup(creds, trackingNumber)` (`returnPickupStatus`) | `{ status, carrierStatus, raw }` — `status` is a pickup status: `requested`, `picked_up`, `in_transit`, `returned_to_merchant`, `failed`, `cancelled`, or `null` for a state we cannot act on (log it) |
| `getReturnPickups(creds, trackingNumbers)` (optional) | `Map(trackingNumber → getReturnPickup result)`, for the poller |
| `cancelReturnPickup(creds, trackingNumber, { carrierShipmentId })` (`returnPickupCancel`) | resolves, or throws when refused |

`address` for `createShipment` is `{ path: [{ id, name, nameAr, level, meta }], firstLine, secondLine }`,
plus `cityId`, `cityName`, `districtId`, `zoneId` for city/district couriers.

## Return pickups (items 372, 396)

| Courier | Book | Status | Cancel | How |
| --- | --- | --- | --- | --- |
| Bosta | yes | webhook (per delivery, re-read from the API) + the merchant's sync; not polled | yes | `POST /deliveries?apiVersion=1` type 25 "Customer Return Pickup" (CRP): customer in `pickupAddress`, parcel in `returnSpecs`, cod 0, original tracking number in `notes`; `GET /deliveries/business/{tn}`; `DELETE …/{tn}/terminate` (Full Access key) |
| Mylerz | yes | polled every 60 min (`GetPackageListStatus`) + sync | yes | `AddOrders` with `Service_Category: "RETURN"` (the official plugin's return order), PP / COD 0; `CancelPackage` by the return barcode |
| J&T Express | **no** | — | — | no reverse / return order among the J&T Egypt open-platform endpoints this adapter was built from (`docs/carriers/jtexpress.md`). A booking answers 422 `CARRIER_NO_RETURN_PICKUP`; the merchant books it with J&T and records it as `manual` |
| Sandbox | yes (`SBX-R-…`) | no (keeps nothing) | yes | local |

Pickup statuses (`return_requests.pickup.status`): `requested` → `picked_up` → `in_transit` → `returned_to_merchant`, or `failed` / `cancelled`.
`returned_to_merchant` and `cancelled` are final. When the courier reports `returned_to_merchant`
an approved return becomes `received` (return.received, source `courier`); stock still comes back
only with the restock step. A pickup the courier collected (`picked_up`, `in_transit`) cannot be
cancelled, nor can its return. Mapping tables: `RETURN_STATE_MAP` in `bosta.js` and `mylerz.js`.

Base URLs: outside production `BOSTA_BASE_URL` / `MYLERZ_BASE_URL` point an adapter at a local
stand-in (`carrierHttp.baseUrlFor`); production always uses the courier's own host.

### Go-live checklist (return pickups)

1. Bosta: check the CRP body against https://docs.bosta.co/api (create delivery, type 25):
   `pickupAddress`, `returnSpecs`, no `specs`, `cod: 0` (UNVERIFIED R1 in `bosta.js`: taken from a
   merchant integration measured against Bosta's live API, docs.bosta.co was unreachable when this was built).
2. Bosta: book one CRP from a test store, confirm in Bosta's dashboard that the courier goes to the
   customer and brings the parcel to the pickup location, and that `GET /deliveries/business/{tn}`
   shows states 22 → 23 → … → 46 (or 45; UNVERIFIED R2). Terminate one while it is still 10/20.
3. Bosta: the per-delivery webhook needs a public https `APP_URL`; otherwise the merchant syncs.
4. Mylerz: book one RETURN order and confirm the barcode's `Status` values along the way; add them to
   `RETURN_STATE_MAP` in `mylerz.js` (only "Delivered, Thank you :-)" and "Rejected - reason to be
   mentioned" are known today; anything else leaves the pickup `requested` and is logged).
5. Mylerz: confirm `CancelPackage` cancels a return barcode before pickup (`IsChanged: true`).
6. J&T: ask J&T Egypt whether the open platform has a reverse order; until then leave it off.

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
- a return pickup (`createReturnPickup`) answers a waybill `SBX-R-` + 8 digits and keeps nothing;
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
