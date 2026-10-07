# Certificate providers

Automatic TLS for merchant domains is done by a **certificate provider**: a
service that issues and renews a certificate for a hostname once the merchant
has pointed it at the platform (Cloudflare for SaaS custom hostnames, Caddy
on-demand TLS, …). The feature code talks only to this interface.

The one adapter is `cloudflare` (`cloudflare.js`, Cloudflare for SaaS custom
hostnames). Another adapter is one file in this folder plus one line in
`index.js`. There is no sandbox adapter.

## Choosing the provider

`CERTIFICATE_PROVIDER` (environment) names the adapter; unset means none:
`POST /domains/:id/ssl/check` answers 502 CERTIFICATE_PROVIDER_ERROR and
verification does not ask for a certificate.

## Cloudflare (`CERTIFICATE_PROVIDER=cloudflare`)

- `CLOUDFLARE_API_TOKEN`: Zone > SSL and Certificates: Edit, on the platform
  zone only. Never logged or put in an error.
- `CLOUDFLARE_ZONE_ID`: that zone's id.
- Requests go to `https://api.cloudflare.com/client/v4` only, with a 10 s
  timeout. `requestCertificate` creates the custom hostname (`ssl.method`
  http, `type` dv, minimum TLS 1.2); a duplicate is looked up by hostname.
- `getStatus` maps Cloudflare's states: hostname and certificate active =
  `issued`; `moved` = `moved` (the merchant's CNAME no longer points at us);
  blocked, `*_timed_out`, expired, deleted = `failed` with Cloudflare's reason
  as `detail`; anything else = `pending`.
- `revoke` deletes the custom hostname; 404 counts as done. Any other failure
  is thrown: the domains service keeps it as a `domain_provider_deletions` row
  and the domains job retries it.
- `listHostnames` (Cloudflare only, not part of the contract) lists every
  custom hostname on the zone, 50 a page, up to 200 pages, for the daily
  reconciliation (`domains.reconcile_provider_hostnames`).

## The contract

An adapter is an object with a `code` and three async methods. All of them
take and return plain objects, never throw for an ordinary "not ready yet",
and throw a `CertificateProviderError` only when the provider itself cannot be
reached or refuses the request.

```js
{
  code: 'sandbox',

  // Ask for a certificate for a hostname the merchant has verified.
  // Idempotent: asking twice for the same hostname returns the same request.
  async requestCertificate({ hostname }) {
    return { status: 'pending' | 'issued' | 'failed', providerRef: 'string', detail: 'string|null' };
  },

  // Where a request stands now. Called when the merchant presses
  // "Check again" and by any future polling job.
  async getStatus({ hostname, providerRef }) {
    return { status: 'pending' | 'issued' | 'failed', detail: 'string|null' };
  },

  // Stop serving / renewing the certificate (the domain was removed).
  // Must not fail if the request is already gone.
  async revoke({ hostname, providerRef }) {
    return { revoked: true };
  },
}
```

| Field | Meaning |
| --- | --- |
| `status: 'pending'` | The provider accepted the request; DNS has not been seen or the certificate is not issued yet |
| `status: 'issued'` | A valid certificate is being served for the hostname |
| `status: 'failed'` | The provider gave up; `detail` is a sentence a merchant can act on |
| `providerRef` | The provider's own id for the request, stored in `domains.ssl_provider_ref` |
| `detail` | Optional human-readable note, shown in the dashboard as is |

## Errors

`CertificateProviderError(message, { retryable })` from `index.js`. The domains
service turns it into `502 CERTIFICATE_PROVIDER_ERROR`; the domain keeps its
previous `ssl_status`.

## How the feature uses it

1. The merchant verifies the domain (TXT record on `_zimos-verify.<host>`).
   Only then does the server call `requestCertificate` →
   `domains.ssl_status = pending`. A failure there leaves `none` and the
   domains job asks again.
2. Every later `POST /domains/:id/ssl/check` → `getStatus` → `ssl_status` updated; on
   `issued` the domain's `status` becomes `active`.
3. Deleting the domain → `revoke`; a failure is retried by the domains job.
   Any delete of a domain row with a `ssl_provider_ref` (the API, a store's or
   account's CASCADE, raw SQL) queues the hostname in
   `domain_provider_deletions` in the same transaction (migration 214's
   trigger); the API's own `revoke` clears that row once it succeeds.
