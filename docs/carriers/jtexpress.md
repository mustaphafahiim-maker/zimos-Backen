# J&T Express (Egypt) adapter notes

Adapter: `src/modules/shipping/carriers/jtexpress.js` (code `jtexpress`).
Rollout: beta only (`CARRIERS_BETA=jtexpress` plus
`CARRIERS_BETA_WORKSPACES=<slug>`).

## Sources (fetched 2026-09-26)

- https://open.jtjms-eg.com — J&T's Egypt open platform. The API docs are
  public, with no login. The site is a Vue app, and every doc page's content
  ships in its JavaScript, which is where we read it:
  - `#/apiDoc/index` — the docking process, where credentials come from,
    both digest algorithms, and sandbox vs production
  - `order/addOrder`, `order/cancelOrder`, `order/printOrder`,
    `order/getOrders`, `logistics/trace`, `trace/subscribe`, the two
    `statusFeedback` push pages, `vip/checkCusPwd`, `location/getLocation`,
    `waybill/getWaybillInfo`
  - the error-code tables and the documented sample requests/responses
- https://download.jtjms-eg.com/open/PHP%2Bsignature%2Bexample.zip — the
  official PHP signature example (the exact digest steps)
- https://download.jtjms-eg.com/open/Project%2Bexample.zip and
  `jt-openapi-sdk.zip` — the official Java SDK sample project
- The platform's SDK page samples (Python/PHP/Java/C#): the Egyptian
  addOrder payload shape, and the sandbox host

Hosts: production `https://openapi.jtjms-eg.com/webopenplatformapi/api`,
sandbox `https://demoopenapi.jtjms-eg.com/webopenplatformapi/api`.

## Capabilities

| capability | value | why |
|---|---|---|
| cancel | `api` | `order/cancelOrder` is documented. It cancels by `txlogisticId`, which we store as `carrierShipmentId` |
| label | true | `order/printOrder` returns `base64EncodeContent` (the sample is a PDF) |
| webhook | `none` | see Unverified 10 |
| polling | true | `logistics/trace` |
| bulkStatus | true | trace takes up to 30 waybills per call (the adapter chunks at 30) |
| addressLevels | `governorate`, `city`, `area` | `getLocation` returns province/city/area rows, and addOrder takes all three names |

## Unverified

The numbers match the `UNVERIFIED (n)` comments in the adapter.

1. **`orderType`.** It is not in addOrder's parameter table, and it is
   required together with `customerCode` in cancelOrder's table ("1
   individual, 2 contract customer"). We default to `2`, and the `orderType`
   setting overrides it for bookings. Cancel always sends `2`.
2. **Location API access.** Whether every merchant account may call
   `location/getLocation` is not stated. Production has shown an account
   refused it ("no interface permissions"). Our request matches the
   official Java SDK sample byte for byte in path, headers, body and digest
   (header digest only, `jtExpressApi.post`). The docs publish no copy of
   the list, so such an account books with typed names (see below).
3. **Scan types 7, 8 and 12.** 7 is "Proxy revenue scan" (代理点收入扫描)
   and 8 is "Express take out scanning" (快件取出扫描); both keep the
   current status. 12 is "Warehousing of stored parts" (留仓件入仓), mapped
   to `failed` (a delivery that did not complete that day). These are
   interpretations of the doc's names.
4. **"Delivery scan" (派件扫描)** appears in the trace sample but not in the
   numbered table. It is mapped to `out_for_delivery`.
5. **Response shape.** `getLocation`'s sample answers `code: "10"` (every
   other sample answers `"1"`), and its `data` is documented as an Object but
   shown as a list. We treat `msg: "success"` with data as success too, and
   read `data` as a list of rows.
6. **Pickup window.** The time zone and the required length of
   `sendStartTime`/`sendEndTime` are not documented. We send now → now+24h
   in Cairo time.
7. **`serviceType` 01 / 02.** Only "must be 01 or 02" is documented. Default
   is `01`; there is a setting for it.
8. **COD ceiling.** Nothing is documented beyond `itemsValue` being
   String(12). COD also needs "COD business" enabled on the J&T account
   (error 145003112).
9. **Cancellable states.** Which states can be cancelled is not documented,
   and neither is the wording of a refusal (only 145003082/145003089 are).
10. **Webhooks.** J&T documents a track push (`statusFeedback`, a form post
    of `bizContent` with apiAccount/digest/timestamp headers). To receive it:
    the callback URL is "provided by the access party" outside the API, each
    waybill is subscribed with `trace/subscribe`, the push digest's algorithm
    is not spelled out, and the expected acknowledgement body appears only in
    a sample (`{"code":"1","msg":"success","data":"SUCCESS"}`). Too much of
    that is unconfirmed, so it is not built; the cron polls.
11. **Trace order and codes.** The order of `details` is not documented, so
    we pick the newest by `scanTime`. The trace sample carries English
    `scanType` labels and a Chinese `problemReason`, but no `scanTypeCode`.
    The mapping reads the code, then the label, then `problemReason`.
12. **Rate limits.** None documented.
13. **Mobile format.** Documented as String(11), so we send
    `01XXXXXXXXX`, but one sample shows `+01111400750`.
14. **Timestamp skew.** The server's tolerance for the `timestamp` header
    is not documented.
15. **`order/getOrders` as a credential check.** The connect check falls
    back to it when `vip/checkCusPwd` is refused for lack of permission. It
    is sent `{ command: 2, serialNumber: ["UEG999999999999"], waybillNos:
    ["UEG999999999999"] }`: a lookup by waybill number for one waybill in the
    documented billCode shape that cannot exist. Nothing is written.
    `waybillNos` is not documented on getOrders (only on
    `waybill/getWaybillInfo`, "1000 at most at one time"), but production
    refused the earlier command 3 probe without it: 999001030
    "参数无效:waybillNos size must be between 1 and 1000;" (HTTP 200).
    `code "1"` (the documented success, rows or none) proves the customer
    code and password. So does 145003064 "no data found", which is documented
    only on addOrder: we assume J&T checks the digest before it looks up any
    data. 145003080 "customer not found" (documented on `ess/balance`) is
    treated like 145003031: 422 `CARRIER_AUTH_FAILED`. Any other refusal,
    e.g. 999001030 (parameter validation), is logged with J&T's code, message and
    HTTP status, and leaves the customer code and password unverified. With
    HTTP 2xx such a refusal still proves the API account and private key
    (J&T passed the header digest and processed the request); see below.
    Production answers 999001030 even though the probe carries `waybillNos`
    (the request was checked through the real adapter code: the field is
    in bizContent). There is no documented code for the
    permission refusal either ("API account has no interface permissions"):
    it is matched by that text (`PERMISSION_CODES` in the adapter takes
    the code once one is seen).

## Credential check and permissions

Connecting runs the first of these the API account may call:

1. `vip/checkCusPwd` (both digests): proves everything.
2. `order/getOrders` (both digests): proves everything (UNVERIFIED 15).
   Refused with any other business code over HTTP 2xx (e.g. 999001030), it
   proves the API account and private key only. getLocation then runs once
   whether or not a pickup address was given. Refused for lack of
   permission, the connection is still saved as active with
   `verification: { customerCredentials: "unverified", locationList:
   "unavailable" }`. The first booking proves or rejects the customer code
   and password, as under 3.
3. `location/getLocation` (header digest only): proves the API account and
   private key. The connection is saved as active with
   `verification: { customerCredentials: "unverified" }` in the connect
   response and on `connection` in `GET /carriers`. The mark is kept in
   `carrier_accounts.settings._verification` and cleared by a later connect
   that proves everything, or by a successful booking. A wrong customer
   code or password then shows at the first booking: 145003031, 422
   `CARRIER_AUTH_FAILED`, account marked invalid. If getLocation is refused
   too, nothing is proven: 422 `CARRIER_PERMISSION_DENIED`, nothing stored.
   This is the only case that fails the connect for permission: every probe
   was refused for permission (or a signature failed: 422
   `CARRIER_AUTH_FAILED`).

With the credentials proven by 1 or 2, getLocation runs only to check a
pickup address. Refused for lack of permission, it no longer fails the
connect: the pickup address is saved unchecked and the connection carries
`verification: { locationList: "unavailable" }`. Every connect sets the
marks afresh.

## Booking without the location list

Capability `typedAddressNames` (J&T only). While a connection has
`locationList: "unavailable"`:

- A booking without `carrierAddress.names` tries the list again. Served,
  the mark is cleared and booking goes on as usual. Refused, it is 422
  `CARRIER_ADDRESS_NAMES_REQUIRED` (`details[0].levels` names the three
  levels). A connection that had the list and is refused it at booking gets
  the mark the same way.
- `carrierAddress: { names: [governorate, city, area] }` is sent to addOrder
  as typed (trimmed, at most 60 characters each), with no matching. The
  shipment keeps `carrierResponse.address = { names }`.
- `names` on a connection that has the list is 422 `VALIDATION_ERROR`.

addOrder's address refusals are 422 `CARRIER_ADDRESS_REJECTED` on the level
they name, for typed names and matched paths alike: 145003062 province
(`.0`), 145003061 city (`.1`), 145003060 area (`.2`), 145003065 the whole
address. J&T does not say whether it means the receiver or the pickup
address. With the pickup address unchecked, the message says so.

Any endpoint J&T refuses for lack of permission (booking, cancelling,
tracking, printing, the location list) is 422 `CARRIER_PERMISSION_DENIED`
naming the endpoint, and the account is **not** marked invalid: the
credentials are fine, J&T has to open the endpoint to the API account.

## What a merchant enters

- Credentials: **API account** (`apiAccount`), **private key**
  (`privateKey`), **customer code**, **customer password**, and optionally
  **environment**. `sandbox` uses J&T's published test credentials and ships
  nothing, so only stores in `CARRIERS_BETA_WORKSPACES` may use it: any
  other store gets 422 on `credentials.environment` when connecting, and a
  stored sandbox connection books nothing (409 `CARRIER_SANDBOX_NOT_ALLOWED`)
  once the store leaves that list.
- Settings: the **pickup address** in J&T's own names (contact name, mobile,
  governorate, city, area, street), which is checked against J&T's location
  list on connect and required to book. Also **default weight** (needed
  unless the store uses weight tiers or product weights), plus optional
  service type, freight payment (`PP_PM` monthly / `PP_CASH`), customer
  type, goods type and label size.

## Getting credentials / carrier-side setup

From the platform's "Docking process" and "Parameter Introduction":

1. Register on https://open.jtjms-eg.com, apply to become a developer, and
   complete **enterprise certification**. After approval, **apiAccount and
   privateKey are shown in the personal center**. This is self-serve.
2. **Customer code and password are "assigned by the platform"**, i.e. by
   the J&T outlet/branch the merchant has a contract with ("provided by
   contacting the shipping outlet"). A merchant without a J&T contract has
   to get one first.
3. The docs also describe joint debugging in the sandbox, then contacting
   J&T's interface staff "to confirm the online details" before production.
4. COD must be enabled on the account (error 145003112 otherwise).
5. Nothing to paste into J&T (no webhook). Status comes from polling, so the
   `sync-carrier-shipments` cron must run.
