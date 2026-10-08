# Google Sheets adapters

The sync (`modules/sheets`, SPEC §16.4) writes orders, lost orders and leads into the merchant's own Google spreadsheets. It talks to Google only through an adapter, chosen by `GOOGLE_SHEETS_PROVIDER`:

| Provider  | State |
| --------- | ----- |
| `sandbox` | Default outside production. No Google: spreadsheets are JSON files in `GOOGLE_SHEETS_SANDBOX_DIR` (default `storage/private/sandbox-sheets`). |
| `google`  | `google.js`: Sheets API v4 + Drive v3 over the merchant's own Google account. Unavailable (`SHEETS_UNAVAILABLE`, 503) until `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET` and `GOOGLE_SHEETS_REDIRECT_URI` are all set. |

In production the sandbox is refused, so until the owner sets `GOOGLE_SHEETS_PROVIDER=google` and the three keys the dashboard shows Google Sheets as unavailable (`SHEETS_UNAVAILABLE`, 503).

## Contract

Every method is `async` and throws an `AppError` on failure. `credentials` is what `exchangeCode` returned; the sync keeps it sealed (`core/utils/secretBox`) in the store's `workspace_integrations` row (`provider = 'google_sheets'`) and never sends it to the browser.

| Method | Does |
| ------ | ---- |
| `authorizeUrl({ redirectUri, state })` → `string` | Where to send the merchant to allow access. `state` must come back untouched. The `google` adapter ignores `redirectUri` and uses `GOOGLE_SHEETS_REDIRECT_URI` (Google accepts only registered ones). |
| `exchangeCode(code, { state })` → `{ account, credentials }` | The code from the redirect, for the account's email and its tokens. `state` is the one that came back (the `google` adapter derives its PKCE verifier from it). |
| `revoke(credentials)` | Optional: disconnecting tells the provider to forget the grant. Best effort, never throws. |
| `isConfigured()` → `boolean` | Optional: false makes `getSheetsAdapter()` answer `SHEETS_UNAVAILABLE` (503). |
| `createSpreadsheet(credentials, { title })` → `{ spreadsheetId, sheetName, url }` | A new spreadsheet with one tab. |
| `openSpreadsheet(credentials, { spreadsheetId, sheetName? })` → `{ spreadsheetId, sheetName, url }` | One the app may already write to; the tab is created when missing. |
| `setHeader(credentials, { spreadsheetId, sheetName, header })` | Writes row 1 (the column titles). |
| `appendRows(credentials, { spreadsheetId, sheetName, rows })` → `{ firstRow }` | Adds rows after the last one. `firstRow` is the 1-based number of the first row written; the sync stores it to rewrite the same rows later. |
| `updateRows(credentials, { spreadsheetId, sheetName, firstRow, rows })` | Replaces the rows from `firstRow` on. |
| `readRows(credentials, { spreadsheetId, sheetName })` → `string[][]` | Optional (the sandbox has it): the rows, for the dashboard's preview. |

`credentials` may carry two non-enumerable hooks, added by `sheetSync.credentialsFor` (`credentialStore.js`): `onRefresh({ accessToken, refreshToken, expiresAt, scope })` keeps a refreshed token sealed in the store's row, and `onRevoked(reason)` marks the account `revoked` (tokens dropped; the overview then answers `account.reconnect: true`). Both act only while the row still holds the same refresh token, so a reconnect made meanwhile is never overwritten.

Error codes the sync acts on:

- `SHEETS_ACCESS_REVOKED` (403): the grant was revoked or expired for good (`invalid_grant` on refresh, a 401 again right after a refresh, or the Drive scope taken away). The account is marked revoked, each connection `revoked`, and the merchant is told once. Nothing is retried. Connecting again resumes the sheets.
- `SHEETS_NOT_FOUND` (404): the spreadsheet or tab is gone (Google 404, or 400 "Unable to parse range" for a renamed/deleted tab). The connection is marked `error`, the merchant is told, and nothing is retried.
- `SHEETS_PERMISSION_DENIED` (403): the account can no longer edit that spreadsheet (Google 403 `PERMISSION_DENIED` on the file). Handled like `SHEETS_NOT_FOUND`.
- Anything else, for example `SHEETS_UNREACHABLE` (5xx, timeouts, 429 — 502, or 429 with `retryAfterSeconds`), `SHEETS_REJECTED` (422, another 400) or `SHEETS_UNAVAILABLE` (503, the platform's client or API setup is wrong): the event is retried by the outbox, and the connection shows the last error.

At connect time: `SHEETS_STATE_INVALID` (400, the state's signature, store, teammate or 15-minute expiry failed), `SHEETS_AUTH_FAILED` (400, the code was used, expired or does not match the PKCE verifier; or no refresh token came back), `SHEETS_SCOPE_MISSING` (400, the merchant unticked the Drive permission on Google's screen; the grant is revoked at once).

## The `google` adapter (`google.js`)

### Setting it up (the owner, once)

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) the project and turn on **Google Sheets API** and **Google Drive API** (APIs & Services → Library). Without them every call answers 403 `SERVICE_DISABLED`, which the adapter logs and answers as `SHEETS_UNAVAILABLE`.
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access): user type *External*; app name, support email, logo, the home page, privacy policy and terms URLs on the platform's domain, and that domain under *Authorized domains*. Scopes: `openid`, `.../auth/userinfo.email` and `https://www.googleapis.com/auth/drive.file`.
3. **Credentials → Create credentials → OAuth client ID**, type *Web application*. Under *Authorized redirect URIs* add the dashboard page that receives Google's answer, e.g. `https://app.<domain>/apps/google-sheets` — the very value of `GOOGLE_SHEETS_REDIRECT_URI` (scheme, host, path; no trailing slash difference).
4. Set on the API servers (never in code): `GOOGLE_SHEETS_PROVIDER=google`, `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET`, `GOOGLE_SHEETS_REDIRECT_URI`. The worker needs them too (it writes the rows).
5. **Verification.** `drive.file` is a *non-sensitive* scope, so no security assessment is needed, but an External app must still be **published** and pass Google's brand verification (domain ownership in Search Console, the privacy policy) before arbitrary merchants can connect. While the app is in *Testing*, only the test users listed on the consent screen can connect, and their refresh tokens expire after 7 days (they show up as `revoked` and must connect again).

### What it does

- **OAuth.** Authorization-code flow: `access_type=offline` and `prompt=consent` (so a refresh token always comes back), scopes `openid email drive.file`, and PKCE (S256). The state is the routes' signed state (store + teammate + expiry, HMAC); the PKCE verifier is an HMAC of that state with the client secret, so nothing is stored between the redirect and the code exchange. The account's email is read from the `id_token` the token endpoint returns (Drive `about` as a fallback). Credentials are `{ accessToken, refreshToken, expiresAt, scope }`, sealed in `workspace_integrations`.
- **Refresh.** Ahead of expiry (one minute before) and once on a 401; the new access token is written back sealed (`onRefresh`). `invalid_grant` → `SHEETS_ACCESS_REVOKED` and `onRevoked`. `invalid_client` (wrong secret) → logged, `SHEETS_UNAVAILABLE`.
- **Create.** `POST /v4/spreadsheets` with the title and one tab `Sheet1` whose first row is frozen.
- **Open** (by id or a pasted `docs.google.com/spreadsheets/d/<id>` link). Drive `files.get` checks it is a live (not trashed) spreadsheet the account can edit, then the tab is added (`addSheet`) when missing. With `drive.file` the app sees only the spreadsheets it created (or ones picked with the Google Picker, which the dashboard does not have yet); any other id answers 404 with a message saying so.
- **Header.** Row 1 is cleared (`values:clear` on `1:1`), then written, so a shorter header leaves no stale titles.
- **Append.** `POST …/values/'Tab'!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`. `RAW` is deliberate: a customer's name must never run as a formula. The first row number comes from `updates.updatedRange` (`'Orders'!A12:P13` → 12). An append whose answer was lost (timeout after Google wrote it) is retried by the outbox and can leave the row twice; Google offers no idempotency key for appends.
- **Update.** `PUT …/values/'Tab'!A{firstRow}?valueInputOption=RAW`.
- **Read.** `GET …/values/'Tab'` (formatted values), for the dashboard's preview.
- **Disconnect.** `POST https://oauth2.googleapis.com/revoke` with the refresh token (best effort), then the row is deleted.
- **Quotas.** Google allows about 60 write requests a minute per user. A 429 (or a 403 `rateLimitExceeded` / `userRateLimitExceeded`) asking to wait at most 10 seconds is waited for and retried here, at most twice; otherwise `SHEETS_UNREACHABLE` (429, `retryAfterSeconds`) goes back to the outbox, which retries with its backoff.
- Tab names are always quoted in A1 notation (`'It''s'!A1`). Every request has a 20-second timeout and never follows redirects. Tokens and the client secret never appear in logs or error messages.

### Local stand-ins

Outside production only, `GOOGLE_SHEETS_AUTH_BASE` (accounts.google.com), `GOOGLE_SHEETS_OAUTH2_BASE` (oauth2.googleapis.com: `/token`, `/revoke`), `GOOGLE_SHEETS_API_BASE` (sheets.googleapis.com) and `GOOGLE_SHEETS_DRIVE_BASE` (www.googleapis.com) point the adapter at a local stand-in. Production ignores them.
