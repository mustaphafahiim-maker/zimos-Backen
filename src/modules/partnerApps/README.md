# Partner apps (OAuth) — for app developers

1. **Register** your app (any ZIMOS account): `POST /api/v1/partner-apps`
   `{ name, description, iconUrl, appUrl, redirectUris: ["https://…/callback"], scopes: ["orders:read", …] }`
   → `clientId` and `clientSecret` (shown once; `POST /partner-apps/:id/rotate-secret` for a new one).
   A new app is in **development**: only stores you are a member of can install it, until ZIMOS publishes it.
2. **Send the merchant** to the dashboard:
   `https://<dashboard>/oauth/authorize?client_id=…&redirect_uri=…&scope=orders:read,orders:write&state=…`
   `redirect_uri` must be one you registered (exactly); `scope` a subset of your app's scopes.
3. **Get the code back**: `redirect_uri?code=…&state=…&store_id=…` (or `?error=access_denied&state=…`).
   Check `state`. The code lasts 10 minutes and works once.
4. **Swap it** from your server: `POST /api/v1/oauth/token`
   `{ grant_type: "authorization_code", code, client_id, client_secret, redirect_uri }`
   → `{ access_token, token_type: "Bearer", scope, store_id, store_name, install_id }`.
   The token works on the public API (`Authorization: Bearer …`, `/api/public/v1/…`) with the approved
   scopes, never beyond the approving person's role, until the store uninstalls the app or you revoke it.
   Asking again (new approval) replaces the token.
5. **Your page in the dashboard** (optional `appUrl`): it opens in a frame at
   `appUrl?store_id=…&timestamp=…&user_id=…&hmac=…`. Verify: `hmac` = hex HMAC-SHA256 with your client
   secret of the other parameters sorted by name and joined `key=value&key=value`; refuse a timestamp
   older than 5 minutes.
6. **Leaving a store**: `POST /api/v1/oauth/revoke { client_id, client_secret, store_id }`.
   When a store uninstalls you, the token stops working (401).

Errors on `/oauth/token`: 401 `invalid_client`, 400 `invalid_grant`. No app charges (SPEC §17.4).
