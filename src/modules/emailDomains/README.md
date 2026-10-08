# Sending domain for customer emails — provider contract

A store can send its customer emails (order emails, cart recovery) from its own
domain, e.g. `orders@ahmedstore.com`, instead of the platform's address. The store
adds DNS records, presses "Verify", and once verified `notify.email` sends its
order emails with that From address. Until then the platform's address is used
with the store's name and Reply-To (`notifications/orderEmailSender.js`).

## Interface (`providers.js`)

| Call | Returns |
|---|---|
| `addDomain(domain)` | `{ providerRef, records: [{ purpose, type, name, value }] }` |
| `verify({ domain, providerRef, records })` | `{ verified, records: [{ …record, ok }] }` |
| `removeDomain({ domain, providerRef })` | nothing |
| `isConfigured()` (optional) | false → 503 `EMAIL_DOMAIN_UNAVAILABLE` |

`purpose` is `spf`, `dkim`, `return_path` or `dmarc` (sandbox), or `brevo_code`, `dkim`, `spf`, `dmarc`
and `ownership` (brevo); DMARC is shown as advised and does not block verification.
`verify` may also return a new `providerRef` (the domain was added again at the provider).

## Adapters

`EMAIL_DOMAIN_PROVIDER` picks one. Unset, it is `brevo` in production when `BREVO_API_KEY` is set, and
`sandbox` outside production. Production never uses the sandbox, even when named (like push and Google
Sheets): with no real provider every sending-domain call answers 503 `EMAIL_DOMAIN_UNAVAILABLE`, the GET
says `available: false`, and the reason is logged once.

| `EMAIL_DOMAIN_PROVIDER` | |
|---|---|
| `sandbox` | Outside production only. Hands out SPF/DKIM/return-path/DMARC records and checks them with real DNS lookups. Registers nothing, signs nothing. `.test`, `.example`, `.invalid`, `.localhost` domains always verify. |
| `brevo` | `brevoDomainProvider.js`, the platform's Brevo account (`BREVO_API_KEY`, the key `notifications/brevoEmailProvider.js` sends with). See below. |

## Brevo

| Step | Brevo call |
|---|---|
| Add | `POST /v3/senders/domains` `{ name }` → `id`, `dns_records`. "Already exists" in the account → `GET /v3/senders/domains/{domain}` and reuse it (`providerRef` `existing:<domain>`, else `new:<id>`). |
| Verify | `PUT /v3/senders/domains/{domain}/authenticate` (a 400 = not yet), then `GET /v3/senders/domains/{domain}`: `authenticated` (and `verified`) plus each record's `status` as `ok`. A domain gone from the account (404) is added again and stays pending. |
| Remove | `DELETE /v3/senders/domains/{domain}` — never for an `existing:` domain, nor while another store still has the domain. |

- Records: every entry of Brevo's `dns_records` is shown with its full name (`host_name` "" → the domain itself): `brevo_code` (the `brevo-code:…` TXT), `dkim` (Brevo's DKIM TXT, or its two `brevo1/brevo2._domainkey` CNAMEs), `spf` / `dmarc` when Brevo lists them. When it lists no DMARC, `_dmarc.<domain>` `v=DMARC1; p=none` is added as advice.
- One record is ours: TXT `_zimos-mail.<domain>` = `zimos-mail=<random per store>` (`ownership`). Every store shares the one Brevo account, so Brevo's records are the same for any store that adds a domain, and a domain the platform itself authenticated reads as authenticated at once. Verified = Brevo says authenticated **and** this TXT is in the domain's DNS (outside production the reserved test TLDs pass it). A domain bought here gets all of them in its zone (item 385).
- Errors: Brevo refuses the domain (400) → 422 `VALIDATION_ERROR` on `domain`; the key or account refused (401/403) → 503 `EMAIL_DOMAIN_UNAVAILABLE` (logged for the owner, the key never); no answer, 429 or 5xx → 502 `EMAIL_DOMAIN_PROVIDER_UNREACHABLE`.
- Sending: once verified, `notify.email` sends through Brevo's `/v3/smtp/email` with `sender.email` = `<localPart>@<domain>` (needs `EMAIL_PROVIDER=brevo`). Brevo accepts any address on an authenticated domain of the account.
- `BREVO_API_BASE` points both this adapter and the email sender at a local stand-in, outside production only; production ignores it.

## Changing provider

A row is only used with the provider that set it up. One verified by the sandbox (or by an earlier
provider) reads as `pending` with `providerChanged: true` and no records, sends from the platform's
address and holds no claim on the domain; the next "Verify" adds it at the current provider and
shows that provider's records.

## Rules

- One domain per store; a domain is refused when another store already uses it.
- Sending from the domain starts only when it is verified by the provider in use, and stops when it is removed, a later check fails, or the provider changes.
- The local part (`orders` by default) is the store's choice: letters, digits, `.`, `_`, `-`.
