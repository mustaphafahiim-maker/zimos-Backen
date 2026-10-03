'use strict';

const env = require('../../config/env');

// Renders transactional emails to { subject, html, text }. Every template
// goes through `wrap`, which appends the shared spam-folder footer.

const SPAM_FOOTER =
  "Didn't get this email? Check your spam/junk folder and mark it as 'not spam' so future emails land in your inbox.";

const SPAM_FOOTER_AR =
  'لم تصلك هذه الرسالة في البريد الوارد؟ ابحث عنها في مجلد الرسائل غير المرغوب فيها وحدّدها بأنها ليست كذلك لتصلك رسائلنا القادمة.';

// `arabicFooter` puts the Arabic footer first; the English one is on every
// email either way.
function wrap(bodyHtml, bodyText, { dir = 'ltr', arabicFooter = false } = {}) {
  const arabicHtml = arabicFooter
    ? `<p dir="rtl" style="font-size:13px;color:#6b7280;margin:0 0 8px">${SPAM_FOOTER_AR}</p>\n`
    : '';
  const html = `<div dir="${dir}" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px" />
${arabicHtml}<p dir="ltr" style="font-size:13px;color:#6b7280;margin:0">${SPAM_FOOTER}</p>
</div>`;
  const text = `${bodyText}\n\n---\n${arabicFooter ? `${SPAM_FOOTER_AR}\n` : ''}${SPAM_FOOTER}`;
  return { html, text };
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const link = (path, token) =>
  `${env.frontendUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

const templates = {
  // The sign-up code (otp/verificationCodeService), in the language the
  // person signed up in. Deliberately no link anywhere: the code is typed
  // into the page that asked for it.
  signup_code(data = {}) {
    const code = String(data.code || '');
    const minutes = Number(data.minutes) || 10;
    const codeHtml = `<p dir="ltr" style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>`;
    if (data.locale === 'en') {
      return {
        subject: 'Your Zimos verification code',
        ...wrap(
          `<p>Your code to confirm your Zimos account:</p>
${codeHtml}
<p>It is valid for ${minutes} minutes and works once.</p>
<p style="color:#6b7280">If you didn't ask for this code, ignore this email. Nobody can use your account without it.</p>`,
          `Your code to confirm your Zimos account: ${code}\n\nIt is valid for ${minutes} minutes and works once.\n\nIf you didn't ask for this code, ignore this email.`
        ),
      };
    }
    return {
      subject: 'رمز تأكيد حسابك في Zimos',
      ...wrap(
        `<p>رمز تأكيد حسابك في Zimos:</p>
${codeHtml}
<p>الرمز صالح لمدة ${minutes} دقائق ولمرة واحدة فقط.</p>
<p style="color:#6b7280">إذا لم تطلب هذا الرمز فتجاهل هذه الرسالة، فلا يمكن لأحد استخدام حسابك من دونه.</p>`,
        `رمز تأكيد حسابك في Zimos: ${code}\n\nالرمز صالح لمدة ${minutes} دقائق ولمرة واحدة فقط.\n\nإذا لم تطلب هذا الرمز فتجاهل هذه الرسالة.`,
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  email_verification(data = {}) {
    const url = link('/verify-email', data.token || '');
    const name = data.fullName ? `Hi ${data.fullName},` : 'Hi,';
    return {
      subject: 'Confirm your email address',
      ...wrap(
        `<p>${name}</p>
<p>Confirm your email address to finish setting up your account:</p>
<p><a href="${url}">Confirm my email</a></p>
<p>If the link doesn't work, paste this into your browser:<br /><span style="color:#6b7280">${url}</span></p>`,
        `${name}\n\nConfirm your email address to finish setting up your account:\n${url}`
      ),
    };
  },

  password_reset(data = {}) {
    const url = link('/reset-password', data.token || '');
    const name = data.fullName ? `Hi ${data.fullName},` : 'Hi,';
    return {
      subject: 'Reset your password',
      ...wrap(
        `<p>${name}</p>
<p>We got a request to reset your password. This link is valid for one hour:</p>
<p><a href="${url}">Reset my password</a></p>
<p>If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
        `${name}\n\nWe got a request to reset your password. This link is valid for one hour:\n${url}\n\nIf you didn't ask for this, you can ignore this email.`
      ),
    };
  },

  workspace_invite(data = {}) {
    const store = data.workspaceName || 'a store';
    const role = data.roleName ? ` as ${data.roleName}` : '';
    const url = `${env.frontendUrl.replace(/\/$/, '')}/invites`;
    return {
      subject: `You've been invited to ${store}`,
      ...wrap(
        `<p>Hi,</p>
<p>You've been invited to join <strong>${store}</strong>${role} on Zimos.</p>
<p><a href="${url}">View the invitation</a></p>
<p>If you don't have an account yet, sign up with this email address and the invite will be waiting for you.</p>`,
        `Hi,\n\nYou've been invited to join ${store}${role} on Zimos.\nView the invitation: ${url}`
      ),
    };
  },

  // A merchant notification sent by email (merchantNotificationService): the
  // same title and body the dashboard bell shows, with a link to the page.
  merchant_notification(data = {}) {
    const title = String(data.title || '');
    const body = data.body ? String(data.body) : '';
    const url = data.link ? `${env.frontendUrl.replace(/\/$/, '')}${data.link}` : null;
    return {
      subject: title,
      ...wrap(
        `<p><strong>${escapeHtml(title)}</strong></p>${body ? `<p>${escapeHtml(body)}</p>` : ''}${url ? `<p><a href="${url}">فتح في لوحة التحكم</a></p>` : ''}`,
        [title, body, url].filter(Boolean).join('\n\n'),
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },
};

function render(template, data) {
  const fn = templates[template];
  if (fn) return fn(data);
  // Fallback so an untemplated notification still sends rather than throwing.
  const lines = Object.entries(data || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    subject: template.replace(/[_-]+/g, ' '),
    ...wrap(`<p>${template}</p><pre>${lines}</pre>`, `${template}\n\n${lines}`),
  };
}

module.exports = { render, wrap, SPAM_FOOTER, TEMPLATE_NAMES: Object.keys(templates) };
