# The platform's WhatsApp number

`notify.whatsapp()` sends from ZIMOS's own number: checkout phone checks
(risk/checkoutOtp.js), phone verification (otp/otpService.js), two-step
sign-in codes (auth/twoFactorWhatsapp.js), and a teammate's notifications when
they turned WhatsApp on for a type (notifications/merchantNotificationService.js,
to their verified phone only). A store's own number — the Inbox and
automations — is configured per store in modules/whatsapp and is not this.

| `WHATSAPP_PROVIDER` | What happens |
|---|---|
| `console` (default) | Development only: the message is logged (codes are redacted in production logs) and counted as sent. **In production `console` counts as not configured**: the send is recorded as failed, so every caller falls back to SMS (or, for sign-in codes, email). |
| `cloud` | Meta's WhatsApp Cloud API, through `notifications/platformWhatsapp.js`. |

## `cloud` settings

| Variable | |
|---|---|
| `WHATSAPP_PLATFORM_PHONE_NUMBER_ID` | The number's id in Meta Business Manager. `sandbox` answers locally (refused in production; a number ending in 0000 fails, to try the SMS fallback). |
| `WHATSAPP_PLATFORM_TOKEN` | A system-user token with `whatsapp_business_messaging`. |
| `WHATSAPP_CODE_TEMPLATE` | The approved authentication template's name (default `zimos_code`). |
| `WHATSAPP_CODE_LANG_AR` / `WHATSAPP_CODE_LANG_EN` | Its language codes (default `ar` / `en_US`); a code for an English page uses the second. |
| `WHATSAPP_ALERT_TEMPLATE` | The approved utility template for teammates' notifications (default `zimos_alert`). |
| `WHATSAPP_ALERT_LANG` | Its language code (default `ar`). |

## The template to create at Meta

Category **Authentication**, with the "copy code" button. Meta writes the body
itself ("{{1}} is your verification code…"); the code goes in the body
parameter and in the button's URL parameter, which is what this adapter sends.

## The alert template (teammates' notifications)

Category **Utility**, three body parameters, for example:

> تنبيه من ZIMOS: {{1}}
> {{2}}
> افتح لوحة التحكم: {{3}}

{{1}} is the notification's title, {{2}} its text (or "—"), {{3}} the
dashboard link. New lines inside a parameter are flattened, as Meta requires.

## Failure

A send that fails (not configured, Meta refuses, the number is not on WhatsApp)
is recorded in `notification_logs` as `failed` and never throws; the callers
then send the same code by SMS. A teammate's notification has no fallback: it
is also in the bell, and by email or push if they turned those on.
