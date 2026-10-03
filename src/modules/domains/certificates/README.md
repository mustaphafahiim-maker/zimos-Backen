# Certificate providers

Automatic TLS for merchant domains is done by a **certificate provider**: a
service that issues and renews a certificate for a hostname once the merchant
has pointed it at the platform (Cloudflare for SaaS custom hostnames, Caddy
on-demand TLS, …). Which one ZIMOS uses is an open decision; the feature code
talks only to this interface.

Only the `sandbox` adapter exists in this repository. A real adapter is one
file in this folder plus one line in `index.js`.

## Choosing the provider

`CERTIFICATE_PROVIDER` (environment) names the adapter; unset means `sandbox`.
The sandbox is refused in production unless `CERTIFICATE_PROVIDER=sandbox` is
set explicitly, so a production deploy never silently reports fake
certificates.

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

1. The merchant verifies the domain (TXT record). The dashboard then calls
   `POST /domains/:id/ssl/check`; the first call on a domain is
   `requestCertificate` → `domains.ssl_status = pending`.
2. Every later `POST /domains/:id/ssl/check` → `getStatus` → `ssl_status` updated; on
   `issued` the domain's `status` becomes `active`.
3. Deleting the domain → `revoke`.

## The sandbox adapter

No network. `requestCertificate` answers `pending` with a ref `SBX-CERT-<hostname>`;
the first `getStatus` after that answers `issued`. A hostname starting with
`fail.` answers `failed`, so the failure path can be exercised.
