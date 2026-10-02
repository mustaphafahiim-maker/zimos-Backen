'use strict';

// The email "forgot password" flow end to end through the notification
// pipeline (Brevo adapter mocked). The request answers at once and the same
// way for every address; the link is emailed after the answer
// (authService.settlePasswordResets waits for it). The token in the email is
// the one that resets the password; it's single-use, time-limited, replaced by
// a newer one, and limited per account and per IP.

jest.mock('../../src/modules/notifications/brevoEmailProvider', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'brevo-mock' }),
  buildPayload: jest.requireActual('../../src/modules/notifications/brevoEmailProvider').buildPayload,
  BREVO_ENDPOINT: 'https://api.brevo.com/v3/smtp/email',
}));

const express = require('express');
const brevo = require('../../src/modules/notifications/brevoEmailProvider');
const notify = require('../../src/modules/notifications/notify');
const emailTemplates = require('../../src/modules/notifications/emailTemplates');
const authService = require('../../src/modules/auth/authService');
const { createPasswordResetLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { hashToken } = require('../../src/core/security/tokens');
const { hashPassword } = require('../../src/core/security/password');
const { app, request, registerAndActivate, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL = { provider: env.notifications.emailProvider, isProduction: env.isProduction, frontendUrlConfigured: env.frontendUrlConfigured };

let emailSpy;
beforeEach(() => {
  brevo.sendEmail.mockClear();
  env.notifications.emailProvider = 'brevo';
  env.notifications.brevo.apiKey = 'test-key';
  env.notifications.brevo.fromAddress = 'store@example.com';
  emailSpy = jest.spyOn(notify, 'email');
});
afterEach(async () => {
  await authService.settlePasswordResets();
  emailSpy.mockRestore();
  env.isProduction = ORIGINAL.isProduction;
  env.frontendUrlConfigured = ORIGINAL.frontendUrlConfigured;
});
afterAll(() => {
  env.notifications.emailProvider = ORIGINAL.provider;
});

const requestReset = async (email, extra = {}) => {
  const res = await request(app).post('/api/v1/auth/password-reset/request').send({ email, ...extra });
  await authService.settlePasswordResets();
  return res;
};
const resetEmails = () => emailSpy.mock.calls.filter((c) => c[0].template === 'password_reset');
const lastToken = () => {
  const calls = resetEmails();
  return calls[calls.length - 1][0].data.token;
};
const confirm = (token, newPassword = 'FreshPass!2026') =>
  request(app).post('/api/v1/auth/password-reset/confirm').send({ token, newPassword });

describe('email forgot-password end to end', () => {
  it('emails a 32-byte link valid 30 minutes whose token resets the password and revokes sessions', async () => {
    const auth = await registerAndActivate();
    brevo.sendEmail.mockClear();
    emailSpy.mockClear();

    const reqRes = await requestReset(auth.email, { locale: 'en' });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body).toEqual({ success: true });

    // the Brevo adapter got the reset email, with the token link + spam footer
    expect(brevo.sendEmail).toHaveBeenCalledTimes(1);
    const sent = brevo.sendEmail.mock.calls[0][0];
    expect(sent.to).toBe(auth.email);
    expect(sent.subject).toMatch(/reset your password/i);
    expect(sent.html).toContain('30 minutes');
    expect(sent.html).toContain(emailTemplates.SPAM_FOOTER);

    const token = lastToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.html).toContain(`${env.frontendUrl.replace(/\/$/, '')}/reset-password?token=${token}`);
    const row = await db.VerificationToken.findOne({ where: { tokenHash: hashToken(token) } });
    expect(row.tokenHash).not.toBe(token); // only the hash is stored
    const minutes = (new Date(row.expiresAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);

    expect((await confirm(token)).status).toBe(200);

    // old refresh token revoked
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken })).status).toBe(401);
    // old password rejected, new one works
    expect((await request(app).post('/api/v1/auth/login').send({ email: auth.email, password: auth.password })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: auth.email, password: 'FreshPass!2026' })).status).toBe(200);
  });

  it('writes the email in Arabic unless the request asks for English', async () => {
    const auth = await registerAndActivate();
    brevo.sendEmail.mockClear();
    await requestReset(auth.email);
    expect(brevo.sendEmail.mock.calls[0][0].subject).toBe('إعادة تعيين كلمة المرور');
    expect(brevo.sendEmail.mock.calls[0][0].html).toContain('30 دقيقة');
  });

  it('the reset token is single-use', async () => {
    const auth = await registerAndActivate();
    await requestReset(auth.email);
    const token = lastToken();

    expect((await confirm(token, 'OnceOnly!2026')).status).toBe(200);
    const second = await confirm(token, 'AgainNope!2026');
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('works once even when the same link is sent twice at the same moment', async () => {
    const auth = await registerAndActivate();
    await requestReset(auth.email);
    const token = lastToken();

    const statuses = (await Promise.all([confirm(token, 'RaceOne!2026'), confirm(token, 'RaceTwo!2026')])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
  });

  it('an expired reset token is rejected', async () => {
    const auth = await registerAndActivate();
    await requestReset(auth.email);
    const token = lastToken();
    await db.VerificationToken.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { tokenHash: hashToken(token), type: 'password_reset' } }
    );

    const res = await confirm(token, 'TooLate!2026');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('a made-up token is rejected the same way', async () => {
    const res = await confirm('a'.repeat(64));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('a newer link replaces the older one', async () => {
    const auth = await registerAndActivate();
    await requestReset(auth.email);
    const first = lastToken();
    await requestReset(auth.email);
    const second = lastToken();

    expect((await confirm(first)).status).toBe(400);
    expect((await confirm(second)).status).toBe(200);
  });
});

describe('the same answer for every address', () => {
  it('an unknown email gets the same answer as a known one, and nothing is stored or sent', async () => {
    const known = await registerAndActivate();
    brevo.sendEmail.mockClear();
    const knownRes = await requestReset(known.email);
    const tokensAfterKnown = await db.VerificationToken.count({ where: { type: 'password_reset' } });

    const unknownRes = await requestReset(uniqueEmail('nobody'));
    expect(unknownRes.status).toBe(knownRes.status);
    expect(unknownRes.body).toEqual(knownRes.body);
    expect(await db.VerificationToken.count({ where: { type: 'password_reset' } })).toBe(tokensAfterKnown);
    expect(brevo.sendEmail).toHaveBeenCalledTimes(1); // the known one only
  });

  it('answers before the email goes out, so the time taken says nothing either', async () => {
    const auth = await registerAndActivate();
    let release;
    brevo.sendEmail.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ messageId: 'late' }))));

    const res = await request(app).post('/api/v1/auth/password-reset/request').send({ email: auth.email });
    expect(res.status).toBe(200); // answered while the email is still being sent
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(release).toBeDefined();
    release();
  });

  it('past three links in an hour an account gets no more, and the answer does not change', async () => {
    const auth = await registerAndActivate();
    emailSpy.mockClear();
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push((await requestReset(auth.email)).body);
    expect(answers).toEqual(Array(4).fill({ success: true }));
    expect(resetEmails()).toHaveLength(3);
  });

  it('a Google account with no password gets a link that sets one', async () => {
    const email = uniqueEmail('google');
    await db.User.create({ email, googleId: 'g-reset-1', fullName: 'Google Person', passwordHash: null, status: 'active', emailVerifiedAt: new Date() });
    const res = await requestReset(email);
    expect(res.body).toEqual({ success: true });

    expect((await confirm(lastToken(), 'FirstPass!2026')).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: email, password: 'FirstPass!2026' })).status).toBe(200);
  });
});

describe('after a reset', () => {
  it('confirms an email not confirmed yet (the link reached its owner), and says so in the audit', async () => {
    const email = uniqueEmail('unconfirmed');
    const user = await db.User.create({ email, passwordHash: await hashPassword('Passw0rd!123'), fullName: 'Pending', status: 'pending_verification' });
    await db.Session.create({ userId: user.id, refreshTokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 86400000) });
    await requestReset(email);

    expect((await confirm(lastToken())).status).toBe(200);
    const after = await db.User.findByPk(user.id);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.status).toBe('active');
    expect(await db.Session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const audit = await db.AuditLog.findOne({ where: { action: 'user.password_reset', entityId: user.id } });
    expect(audit.metadata).toEqual({ emailConfirmed: true, sessionsRevoked: 1 });
  });

  it('leaves a confirmed email as it was', async () => {
    const auth = await registerAndActivate();
    const before = await db.User.findOne({ where: { email: auth.email } });
    await requestReset(auth.email);
    await confirm(lastToken());
    const after = await db.User.findByPk(before.id);
    expect(after.emailVerifiedAt.getTime()).toBe(before.emailVerifiedAt.getTime());
    const audit = await db.AuditLog.findOne({ where: { action: 'user.password_reset', entityId: before.id } });
    expect(audit.metadata.emailConfirmed).toBe(false);
  });
});

describe('where the link points', () => {
  it('in production without FRONTEND_URL every request is refused alike and nothing is sent', async () => {
    const known = await registerAndActivate();
    brevo.sendEmail.mockClear();
    env.isProduction = true;
    env.frontendUrlConfigured = false;

    for (const email of [known.email, uniqueEmail('nobody')]) {
      const res = await requestReset(email);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PASSWORD_RESET_UNAVAILABLE');
    }
    expect(brevo.sendEmail).not.toHaveBeenCalled();

    env.frontendUrlConfigured = true;
    expect((await requestReset(known.email)).status).toBe(200);
  });
});

describe('the per-IP limit', () => {
  it('refuses an IP past its hourly allowance, whatever the email, and not another IP', async () => {
    const limited = express();
    limited.set('trust proxy', 1);
    limited.use(express.json());
    limited.post('/reset', createPasswordResetLimiter({ hourMax: 3 }), (req, res) => res.json({ success: true }));
    limited.use(errorHandler);

    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await request(limited).post('/reset').set('X-Forwarded-For', '198.51.100.7').send({ email: `x${i}@example.com` })).status
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await request(limited).post('/reset').set('X-Forwarded-For', '198.51.100.8').send({ email: 'y@example.com' })).status).toBe(200);
  });
});
