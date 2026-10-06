# Google Sheets adapters

The sync (`modules/sheets`, SPEC §16.4) writes orders, lost orders and leads into the merchant's own Google spreadsheets. It talks to Google only through an adapter, chosen by `GOOGLE_SHEETS_PROVIDER`:

| Provider  | State |
| --------- | ----- |
| `sandbox` | Default outside production. No Google: spreadsheets are JSON files in `GOOGLE_SHEETS_SANDBOX_DIR` (default `storage/private/sandbox-sheets`). |
| `google`  | **Not written yet.** Needs the Google Cloud project, the OAuth consent screen's review for the `drive.file` scope, and its client id/secret — an owner's task. |

In production the sandbox is refused, so until the `google` adapter is registered the dashboard shows Google Sheets as unavailable (`SHEETS_UNAVAILABLE`, 503).

## Contract

Every method is `async` and throws an `AppError` on failure. `credentials` is what `exchangeCode` returned; the sync keeps it sealed (`core/utils/secretBox`) in the store's `workspace_integrations` row (`provider = 'google_sheets'`) and never sends it to the browser.

| Method | Does |
| ------ | ---- |
| `authorizeUrl({ redirectUri, state })` → `string` | Where to send the merchant to allow access. `state` must come back untouched. |
| `exchangeCode(code)` → `{ account, credentials }` | The code from the redirect, for the account's email and its tokens. |
| `createSpreadsheet(credentials, { title })` → `{ spreadsheetId, sheetName, url }` | A new spreadsheet with one tab. |
| `openSpreadsheet(credentials, { spreadsheetId, sheetName? })` → `{ spreadsheetId, sheetName, url }` | One the app may already write to; the tab is created when missing. |
| `setHeader(credentials, { spreadsheetId, sheetName, header })` | Writes row 1 (the column titles). |
| `appendRows(credentials, { spreadsheetId, sheetName, rows })` → `{ firstRow }` | Adds rows after the last one. `firstRow` is the 1-based number of the first row written; the sync stores it to rewrite the same rows later. |
| `updateRows(credentials, { spreadsheetId, sheetName, firstRow, rows })` | Replaces the rows from `firstRow` on. |
| `readRows(credentials, { spreadsheetId, sheetName })` → `string[][]` | Optional (the sandbox has it): the rows, for the dashboard's preview. |

Error codes the sync acts on:

- `SHEETS_ACCESS_REVOKED`: the token was revoked or expired for good (`invalid_grant`, 401/403). The connection is marked `revoked` and the merchant is told once. Nothing is retried.
- `SHEETS_NOT_FOUND`: the spreadsheet or tab is gone. The connection is marked `error`, the merchant is told, and nothing is retried.
- Anything else, for example `SHEETS_UNREACHABLE` (5xx, timeouts, 429): the event is retried by the outbox, and the connection shows the last error.

## Writing the `google` adapter

- **OAuth.** Use the authorization-code flow with `access_type=offline` and `prompt=consent` (so a refresh token comes back) and the scope `https://www.googleapis.com/auth/drive.file`, which only covers files the app creates or the merchant picks. Store `{ accessToken, refreshToken, expiresAt }`. Refresh the access token when it is close to expiry. `invalid_grant` on refresh means revoked.
- **Create.** `POST https://sheets.googleapis.com/v4/spreadsheets` with `properties.title`.
- **Picking an existing file** needs the Google Picker in the dashboard (with `drive.file`, the app sees only what was picked). Until then, only spreadsheets the app created can be reused.
- **Append.** `POST …/values/{tab}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`. `RAW` is deliberate: a customer's name must never run as a formula. Read the first row number from `updates.updatedRange` (e.g. `Orders!A12:P12` → 12).
- **Update.** `PUT …/values/{tab}!A{firstRow}?valueInputOption=RAW`.
- **Quotas.** Google allows about 60 write requests a minute per user. On 429, throw `SHEETS_UNREACHABLE` so the outbox retries with its backoff.
