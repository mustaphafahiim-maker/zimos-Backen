'use strict';

// Checkout phone codes (risk/checkoutOtp, otp/otpService): tries counted in
// one statement, single use, Resend bound to a phone this store challenged,
// and the optional per-client send budget (env.checkoutOtp).

const notify = require('../../src/modules/notifications/notify');
const otpService = require('../../src/modules/otp/otpService');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const OTP_SETTINGS = { enabled: true, channel: 'sms', apply_to: 'all', code_length: 4 };

let smsSpy;
beforeEach(() => {
  smsSpy = jest.spyOn(notify, 'sms');
});
afterEach(() => {
  smsSpy.mockRestore();
  env.checkoutOtp.ipPerMinute = 0;
  env.checkoutOtp.ipPerHour = 0;
});

async function storeWithOtp() {
  const ctx = await setupWorkspaceWithProduct({ stock: 50 });
  const workspace = await db.Workspace.findByPk(ctx.workspace.id);
  const settings = { ...(workspace.settings || {}) };
  settings.fraud_rules = { ...(settings.fraud_rules || {}), checkout_otp: OTP_SETTINGS };
  await workspace.update({ settings });
  return ctx;
}

const checkout = (workspaceId, variantId, phone, ip = '203.0.113.7') =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('X-Forwarded-For', ip)
    .set('Idempotency-Key', `otp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ item: { variantId, quantity: 1 }, contact: { fullName: 'Otp Shopper', phone }, paymentMethod: 'cod' });

const resend = (workspaceId, phone, ip = '203.0.113.7') =>
  request(app).post(`/api/v1/store/${workspaceId}/checkout/otp/resend`).set('X-Forwarded-For', ip).send({ phone });

describe('otpService.verifyOtp under parallel guesses', () => {
  it('parallel wrong guesses share the same 5 tries', async () => {
    await otpService.generateAndSendOtp('01011112222', 'phone_verification');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => otpService.verifyOtp('01011112222', 'phone_verification', '000000')));
    const codes = results.map((r) => r.reason && r.reason.code);
    expect(codes.filter((c) => c === 'INVALID_CODE')).toHaveLength(5);
    expect(codes.filter((c) => c === 'TOO_MANY_ATTEMPTS')).toHaveLength(5);
    const row = await db.OtpCode.findOne({ where: { purpose: 'phone_verification' }, order: [['createdAt', 'DESC']] });
    expect(row.attempts).toBe(5);
  });

  it('two right answers at once verify only once', async () => {
    await otpService.generateAndSendOtp('01011113333', 'phone_verification');
    const code = smsSpy.mock.calls[smsSpy.mock.calls.length - 1][0].data.code;
    const results = await Promise.allSettled([
      otpService.verifyOtp('01011113333', 'phone_verification', code),
      otpService.verifyOtp('01011113333', 'phone_verification', code),
      otpService.verifyOtp('01011113333', 'phone_verification', code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('checkout codes: Resend and the send budget', () => {
  it('Resend for a phone this store never challenged sends nothing (409 OTP_NOT_REQUESTED)', async () => {
    const { workspace } = await storeWithOtp();
    const res = await resend(workspace.id, '01099990000');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OTP_NOT_REQUESTED');
    expect(smsSpy).not.toHaveBeenCalled();
    expect(await db.OtpCode.count()).toBe(0);
  });

  it('a phone challenged by another store cannot be sent a code through this one', async () => {
    const A = await storeWithOtp();
    const B = await storeWithOtp();
    const first = await checkout(A.workspace.id, A.variant.id, '01077770000');
    expect(first.status).toBe(428);
    const res = await resend(B.workspace.id, '01077770000');
    expect(res.status).toBe(409);
  });

  it('the checkout records the store and the client on the code; Resend then works after the wait', async () => {
    const { workspace, variant } = await storeWithOtp();
    const first = await checkout(workspace.id, variant.id, '01066660000');
    expect(first.status).toBe(428);
    expect(first.body.error.code).toBe('OTP_REQUIRED');
    const row = await db.OtpCode.findOne({ where: { purpose: 'checkout' } });
    expect(row.workspaceId).toBe(workspace.id);
    expect(row.requestIp).toBeTruthy();

    // Too soon: the existing one-minute wait still answers.
    const tooSoon = await resend(workspace.id, '01066660000');
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('OTP_RESEND_TOO_SOON');

    await db.sequelize.query('UPDATE otp_codes SET created_at = now() - interval \'2 minutes\' WHERE id = :id', { replacements: { id: row.id } });
    const again = await resend(workspace.id, '01066660000');
    expect(again.status).toBe(200);
    expect(await db.OtpCode.count({ where: { purpose: 'checkout' } })).toBe(2);
  });

  it('with no budget set, one client is not limited across phones (as before)', async () => {
    const { workspace, variant } = await storeWithOtp();
    for (let i = 0; i < 4; i += 1) {
      const res = await checkout(workspace.id, variant.id, `0105555000${i}`);
      expect(res.status).toBe(428);
    }
    expect(await db.OtpCode.count({ where: { purpose: 'checkout' } })).toBe(4);
  });

  it('with CHECKOUT_OTP_IP_PER_MINUTE set, one client past it gets 429 and nothing is sent', async () => {
    env.checkoutOtp.ipPerMinute = 3;
    const { workspace, variant } = await storeWithOtp();
    for (let i = 0; i < 3; i += 1) {
      const res = await checkout(workspace.id, variant.id, `0104444000${i}`);
      expect(res.status).toBe(428);
    }
    smsSpy.mockClear();
    const fourth = await checkout(workspace.id, variant.id, '01044440009');
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('OTP_RATE_LIMITED');
    expect(smsSpy).not.toHaveBeenCalled();

    // Another client is not affected.
    const other = await checkout(workspace.id, variant.id, '01044440010', '198.51.100.9');
    expect(other.status).toBe(428);
  });

  it('a phone blocked from codes gets a stand-in row: no SMS, and Resend answers as for any phone', async () => {
    const { workspace, variant } = await storeWithOtp();
    const { normalizePhone } = require('../../src/core/utils/phone');
    await db.BlockedEntry.create({ workspaceId: workspace.id, type: 'phone', scope: 'otp', value: normalizePhone('01033330000', '20'), label: '01033330000' });

    const first = await checkout(workspace.id, variant.id, '01033330000');
    expect(first.status).toBe(428);
    expect(smsSpy).not.toHaveBeenCalled();
    const row = await db.OtpCode.findOne({ where: { purpose: 'checkout' } });
    expect(row).not.toBeNull();
    const res = await resend(workspace.id, '01033330000');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_RESEND_TOO_SOON');
  });
});
