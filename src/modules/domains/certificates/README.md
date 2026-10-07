# Certificate providers

Automatic TLS for merchant domains is done by a **certificate provider**: a
service that issues and renews a certificate for a hostname once the merchant
has pointed it at the platform (Cloudflare for SaaS custom hostnames, Caddy
on-demand TLS, …). The feature code talks only to this interface.

Two adapters exist: `sandbox` (no network) and `cloudflare` (`cloudflare.js`,
Cloudflare for SaaS custom hostnames; item 341, Ziad's b600e71). Another
adapter is one file in this folder plus one line in `index.js`.

## Choosing the provider

`CERTIFICATE_PROVIDER` (environment) names the adapter; unset means `sandbox`.
The sandbox is refused in production unless `CERTIFICATE_PROVIDER=sandbox` is
set explicitly, so a production deploy never silently reports fake
certificates. With no usable provider, `POST /domains/:id/ssl/check` answers
502 CERTIFICATE_PROVIDER_ERROR, verification asks for no certificate and the
certificate jobs do nothing.

## Cloudflare (`CERTIFICATE_PROVIDER=cloudflare`)

- `CLOUDFLARE_API_TOKEN`: Zone > SSL and Certificates: Edit, on the platform
  zone only. Never logged or put in an error.
- `CLOUDFLARE_ZONE_ID`: that zone's id (32 hex characters).
- Point merchants at the zone's fallback origin with
  `CUSTOM_DOMAIN_CNAME_TARGET` (e.g. `customers.zimos.co`); unset, each store's
  `<slug>.<PLATFORM_ROOT_DOMAIN>` is the target, which must then be a host in
  that zone too.
- Requests go to `https://api.cloudflare.com/client/v4` only, with a 10 s
  timeout. `requestCertificate` creates the custom hostname (`ssl.method`
  http, `type` dv, minimum TLS 1.2); a duplicate is looked up by hostname.
- `getStatus` maps Cloudflare's states: hostname and certificate active =
  `issued`; `moved` = `moved` (the merchant's DNS no longer points at us);
  blocked, `*_timed_out`, expired, deleted = `failed` with Cloudflare's reason
  as `detail`; anything else = `pending`.
- `revoke` deletes the custom hostname; 404 counts as done. Any other failure
  is thrown: the domains service keeps it as a `domain_provider_deletions` row
  and the domains job retries it.

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
  // "Check again" and by the domains jobs.
  async getStatus({ hostname, providerRef }) {
    return { status: 'pending' | 'issued' | 'failed' | 'moved', detail: 'string|null' };
  },

  // Stop serving / renewing the certificate (the domain was removed).
  // Must not fail if the request is already gone; throw when it could not be
  // removed, so it is retried.
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
| `status: 'moved'` | The certificate was issued but the hostname no longer points at the platform |
| `providerRef` | The provider's own id for the request, stored in `domains.ssl_provider_ref` |
| `detail` | Optional human-readable note, stored in `domains.ssl_detail` and shown in the dashboard as is |

## Errors

`CertificateProviderError(message, { retryable })` from `errors.js` (also
exported by `index.js`). The domains service turns it into
`502 CERTIFICATE_PROVIDER_ERROR`; the domain keeps its previous `ssl_status`.

## How the feature uses it

1. The merchant verifies the domain (TXT record on `_zimos-verify.<host>`; a
   domain added before item 341 may still have it on the host itself). Right
   then the server calls `requestCertificate` → `domains.ssl_status = pending`
   and `ssl_requested_at` is set. A failure there leaves `none`; the domains
   job asks again. A domain bought in the dashboard does the same once its
   records are set.
2. Every later `POST /domains/:id/ssl/check`, and the domains job every 5
   minutes (`domains.poll_certificates`) → `getStatus` → `ssl_status` updated;
   on `issued` the domain's `status` becomes `active`. Still not issued 72
   hours after `ssl_requested_at`, the job sets `failed` with a reason.
3. Once a day (`domains.check_active_certificates`) an issued domain is asked
   again, to notice `moved`: it is then no longer the store's canonical
   address (primaryHost.js) until the merchant points it back.
4. Deleting the domain → `revoke`; a failure is kept in
   `domain_provider_deletions` and retried by `domains.retry_provider_deletions`
   (every 15 minutes, waiting longer after each failure, up to 6 hours).
5. A root domain or its www whose counterpart is sent to it
   (domains/rootDomains.js) needs the counterpart certified too: a visitor
   reaches www.<root> over https before being sent on. Each check asks the
   provider about the counterpart's hostname as well, as its own request
   (`domains.counterpart.sslProviderRef`); turning the redirect off or
   deleting the domain revokes it (a failure is retried like the domain's). A
   provider failure for the counterpart never fails the domain's own check.

## The sandbox adapter

No network. `requestCertificate` answers `pending` with a ref `SBX-CERT-<hostname>`;
the first `getStatus` after that answers `issued`. A hostname starting with
`fail.` answers `failed`, so the failure path can be exercised.
