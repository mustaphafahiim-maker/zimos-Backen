# Sign in with Google for shopper accounts (spec-gaps item 217)

The storefront shows Google's own "Sign in with Google" button (Google Identity Services). Google hands the
browser an **ID token**; the storefront posts it to `POST /store/:ws/account/google`, and the server verifies it
here and signs the shopper in to their account (the same `X-Shopper-Token` as a code sign-in).

## Adapters

| file | when |
|---|---|
| `google.js` | real: verifies the ID token with `google-auth-library` against the client id below |
| `sandbox.js` | `SHOPPER_GOOGLE_MODE=sandbox` (not in production): the token `sandbox:<email>:<subject>` is accepted as is |

## Client id

A Google OAuth **web client id** lists the domains the button may run on. Each store can set its own
(`settings.shopper_google.clientId`, `PUT /workspaces/:ws/shopper-accounts/google`) — needed for a custom
domain. Without one, the platform's `GOOGLE_CLIENT_ID` is used, which covers the platform's own store addresses.
The client id is public; there is no secret in this flow.

## Linking

Only an email Google says is verified is used. It signs in to the store's existing contact with that email
(made by an earlier order or sign-in). A store contact needs a phone number, so Google alone does not create one:
the shopper places an order or signs in with their phone first, and Google works from then on.
