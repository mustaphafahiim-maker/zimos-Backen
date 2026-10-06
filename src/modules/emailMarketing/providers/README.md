# Email-marketing providers (spec-gaps item 182)

A store sends its contacts who agreed to marketing to a list in an email
marketing service. `emailMarketing.js` holds the connection (a
`workspace_integrations` row `email_marketing:<code>`, the key sealed with
secretBox and never returned), the settings (list, tags, which contacts) and
the sync; a provider only talks to its service.

## Contract

```js
module.exports = {
  code: 'mailchimp',              // [a-z0-9_]
  name: 'Mailchimp',
  isTest: false,
  credentialFields: [{ key: 'apiKey', label: { en, ar }, secret: true, required: true }],
  async verifyCredentials(c)            // → { accountName }
  async lists(c)                        // → [{ id, name, memberCount|null }]
  async upsertContacts(c, listId, contacts) // → { synced }; adds or updates, subscribed
  async unsubscribe(c, listId, email)   // optional: consent withdrawn
};
```

A contact: `{ email, firstName, lastName, phone, tags: [], source: 'lead'|'buyer'|… }`.
Only contacts with an email, `marketingConsent = true` and not blocked are
ever passed in.

Errors: throw `{ code, status }` with `EMAIL_MARKETING_INVALID_CREDENTIALS` 422,
`EMAIL_MARKETING_LIST_NOT_FOUND` 404, `EMAIL_MARKETING_REJECTED` 409,
`EMAIL_MARKETING_UNAVAILABLE` 502 (`http.js` maps the HTTP answers). An
unavailable service makes the outbox retry the contact; any other failure is
kept as the connection's `lastError` and shown on its card.

## Adapters

- `mailchimp.js` — Marketing API 3.0; the API key's data centre ("…-us21")
  names the host. PUT member by MD5 of the lower-cased email,
  `status_if_new: subscribed`, FNAME/LNAME/PHONE, then tags.
  Unsubscribe = PATCH status `unsubscribed`.
- `klaviyo.js` — API revision 2024-10-15, private key with lists, profiles
  and subscriptions scopes. Bulk subscription jobs of 100, then profile
  import for names and tags (`zimos_tags`). Unsubscribe = bulk delete job.
- `sandbox.js` — no network, any key except `invalid`, two lists, kept in
  memory. Registered outside production only, shown as "Test".

Mailchimp and Klaviyo are app-store apps (`apps/appCatalogue.js`): they work
while installed.
