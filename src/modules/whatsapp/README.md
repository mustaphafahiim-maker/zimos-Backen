# WhatsApp (official Cloud API only)

The store connects its own WhatsApp Business number (Meta's Cloud API). There
is no QR / unofficial WhatsApp and no bulk or campaign sending (SPEC §21).

| File | What it does |
| --- | --- |
| `whatsappCloud.js` | Thin Graph API client: verify a number, send text / template, list, create and find message templates. Base URL `WHATSAPP_GRAPH_BASE` (default `https://graph.facebook.com/v21.0`; point it at a local stand-in to try things without Meta). |
| `whatsappSandbox.js` | The `sandbox` adapter: a store connected with phone number id `sandbox` gets the same calls answered locally. Refused in production. |
| `whatsappService.js` | Connect / disconnect (`WorkspaceIntegration` provider `whatsapp_cloud`; the access token and app secret sealed with `secretBox`, never returned or logged), sending, the inbox, Meta's webhook (signed with the app secret). |
| `whatsappTemplates.js` | The account's templates in `whatsapp_templates`, synced from Meta and kept current by the `message_template_status_update` webhook. |
| `templateSubmission.js` | "Create on WhatsApp" for the ready-made automations (item 391), below. |
| `templateLanguage.js` | Which language a template goes out in for an order (item 383). |

## Connection

`PUT /workspaces/:ws/whatsapp/integration { phoneNumberId, accessToken, businessAccountId?, appSecret? }`.
`businessAccountId` (the WABA id) is needed to sync and to create templates; `appSecret` to accept webhooks.

## Creating the ready-made templates on WhatsApp (item 391)

`POST /workspaces/:ws/automations/templates/:key/whatsapp` (`automations.manage`)
with `{ activateWhenApproved = true, locale, couponCode, languages? }`;
`GET` the same path for where it stands.

- The rule is the store's ready-made rule for `key`, or a new one made from it, **off**.
- Every template the rule's steps send is submitted in the step's language
  (Arabic) and in English when the store offers English (`settings.store_languages`),
  unless `languages` says otherwise. Only Arabic and English texts exist
  (`automationTemplates.js` holds the Arabic, `templateSubmission.js` the English).
- Request to Meta, as documented for `POST /{waba-id}/message_templates`:

  ```json
  { "name": "order_confirmation", "language": "ar", "category": "UTILITY",
    "components": [
      { "type": "BODY", "text": "مرحبًا {{1}}، استلمنا طلبك رقم {{2}} بإجمالي {{3}}. …",
        "example": { "body_text": [["أحمد", "1001", "٢٥٠ جنيه"]] } },
      { "type": "BUTTONS", "buttons": [{ "type": "QUICK_REPLY", "text": "تأكيد الطلب" }, { "type": "QUICK_REPLY", "text": "إلغاء" }] } ] }
  ```
  `buildComponents` also takes an optional TEXT `header` and a `footer`.
  Meta answers `{ id, status, category }`; the row is stored with that status (usually `PENDING`).
  A body that ends with a variable gets a closing line, because Meta refuses
  variables at the start or end. Abandoned-cart reminders are `MARKETING`, the rest
  `UTILITY` (Meta may move a template to another category itself).
- Errors from `createTemplate`:

  | Meta | ZIMOS |
  | --- | --- |
  | code 100, subcode 2388024 "content in this language already exists" | `WHATSAPP_TEMPLATE_NAME_TAKEN` 409, `details.reusable: true` → the existing template is fetched (`GET /{waba-id}/message_templates?name=`) and linked (`outcome: "reused"`) |
  | subcode 2388023 "being deleted" | `WHATSAPP_TEMPLATE_NAME_TAKEN` 409, not reusable — returned to the merchant |
  | HTTP 429, codes 4, 17, 32, 613, 80007, 80008, 130429 | `WHATSAPP_RATE_LIMITED` 429 |
  | 401, codes 190, 10, 200 | `WHATSAPP_AUTH_FAILED` 422 |
  | any other 4xx | `WHATSAPP_TEMPLATE_REJECTED` 422 with Meta's `error_user_msg`, `details.metaCode/metaSubcode` |
  | 5xx / network | `WHATSAPP_API_ERROR` 502 / `WHATSAPP_UNREACHABLE` 502 |

  Any error rolls the whole submit back (rule and rows); a template Meta did
  create before it is linked by the next submit through the "name taken" path.
- Idempotent: a (name, language) the store already has a row for is linked to
  the rule, never sent again; submits for one store and automation are
  serialised by an advisory lock. A template already REJECTED is not re-sent —
  the merchant edits it in WhatsApp Manager and syncs.
- The rule turns on only when every template its steps send is `APPROVED` in
  the step's language. With `activateWhenApproved` (default) it is marked to
  switch itself on; a rule that was already on is paused until then. Already
  approved: on at once. Switching the rule by hand (`PATCH isActive`) cancels
  the automatic switch-on.
- After the status webhook or a sync, `reconcile()` switches waiting rules on
  (audited `automation.update` with no actor, bell `whatsapp.template`
  `event: activated`) and rings the bell once per rejection of a submitted
  template with Meta's reason (`event: rejected`).
- Sandbox number: `createTemplate` answers `PENDING`; a sync then answers the
  fixed list (the ready-made Arabic templates approved, `cart_reminder_last`
  pending), which approves them — English rows are dropped by that sync, as
  the fixed list has none.
