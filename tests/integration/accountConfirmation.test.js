'use strict';

// Soft confirmation (REQUIRE_SIGNUP_VERIFICATION off): signing in by email or
// username, a new account signed in at once with its email still to confirm,
// the dashboard's code endpoints (/auth/me/email), and what an unconfirmed
// account may not do (core/middleware/confirmedAccount): start a trial or put
// anything live. Also the two places that used to rely on "active" meaning
// "confirmed": console roles and store invitations.

const { app, request, uniqueEmail, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const { hashPassword } = require('../../src/core/security/password');

const ORIGINAL_SIGNUP = { ...env.signup, smsCountryCodes: [...env.signup.smsCountryCodes] };
const ORIGINAL_NOTIFICATIONS = JSON.parse(JSON.stringify(env.notifications));
const ORIGINAL_PRODUCTION = env.isProduction;

let outbox = [];
beforeEach(() => {
  env.signup.requireVerification = false;
  outbox = [];
  jest.spyOn(notify, 'email').mockImplementation(async (opts) => {
    outbox.push(opts);
    return { status: 'sent' };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env.signup, ORIGINAL_SIGNUP, { smsCountryCodes: [...ORIGINAL_SIGNUP.smsCountryCodes] });
  Object.assign(env.notifications, JSON.parse(JSON.stringify(ORIGINAL_NOTIFICATIONS)));
  env.isProduction = ORIGINAL_PRODUCTION;
});

const PASSWORD = 'Passw0rd!123';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const lastCode = () => outbox[outbox.length - 1].data.code;
const wrongCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
const login = (body) => request(app).post('/api/v1/auth/login').send({ password: PASSWORD, ...body });
const me = (token) => request(app).get('/api/v1/auth/me').set(bearer(token));
const sendCode = (token, body = {}) => request(app).post('/api/v1/auth/me/email/send-code').set(bearer(token)).send(body);
const confirmCode = (token, code) => request(app).post('/api/v1/auth/me/email/confirm').set(bearer(token)).send({ code });

/** A new account, signed up the soft way: signed in, its email not confirmed. */
async function softAccount(overrides = {}) {
  const email = overrides.email || uniqueEmail('soft');
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Soft Person', locale: 'en', ...overrides });
  expect(res.status).toBe(201);
  return { email, userId: res.body.user.id, accessToken: res.body.accessToken, H: bearer(res.body.accessToken), body: res.body };
}

function tree(text = 'Hello') {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [{ id: 'r1', type: 'row', settings: {}, columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }],
      },
    ],
  };
}

async function websiteWithPage(wid, H) {
  const site = (await request(app).post(`/api/v1/workspaces/${wid}/websites`).set(H).send({ name: 'Site' })).body.website;
  const page = await request(app).post(`/api/v1/workspaces/${wid}/websites/${site.id}/pages`).set(H).send({ path: '/', title: 'Home', draftData: tree() });
  expect(page.status).toBe(201);
  return site;
}

async function funnelWithSteps(wid, H) {
  const base = `/api/v1/workspaces/${wid}/funnels`;
  const funnel = (await request(app).post(base).set(H).send({ name: 'Launch' })).body.funnel;
  await request(app).post(`${base}/${funnel.id}/steps`).set(H).send({ key: 'landing', stepType: 'landing', name: 'Landing', builderData: tree() });
  await request(app).post(`${base}/${funnel.id}/steps`).set(H).send({ key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree('done') });
  await request(app).post(`${base}/${funnel.id}/edges`).set(H).send({ fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
  return funnel;
}

const expectNotConfirmed = (res, email) => {
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  expect(res.body.error.details).toEqual({ email: `${email[0]}***@example.com` });
};

describe('signing in with the email or the username', () => {
  it('takes either, whatever the letter case, and the old `email` field still works', async () => {
    const email = uniqueEmail('ident');
    await softAccount({ email, username: 'shop.owner' });

    for (const identifier of ['shop.owner', 'Shop.Owner', email, email.toUpperCase(), `  ${email}  `]) {
      const res = await login({ identifier });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    }
    expect((await login({ email })).status).toBe(200);
  });

  it('gives the same answer for an unknown username, an unknown email and a wrong password', async () => {
    const email = uniqueEmail('same');
    await softAccount({ email, username: 'known.user' });
    const answers = await Promise.all([
      login({ identifier: 'nobody.here' }),
      login({ identifier: uniqueEmail('nobody') }),
      login({ identifier: 'known.user', password: 'Wrong-pass1' }),
      login({ identifier: email, password: 'Wrong-pass1' }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid sign-in details' });
    }
  });

  it('refuses a sign-in that names no account at all', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(422);
  });

  it('lets in an account still pending from before, active, with its email still to confirm', async () => {
    const email = uniqueEmail('legacy');
    await db.User.create({ email, passwordHash: await hashPassword(PASSWORD), fullName: 'Legacy', status: 'pending_verification' });
    const res = await login({ identifier: email });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('active');
    expect((await me(res.body.accessToken)).body.confirmed).toBe(false);
  });
});

describe('a new account (sign-up codes off)', () => {
  it('is signed in at once and still signs up when no code can be sent', async () => {
    env.isProduction = true;
    env.notifications.emailProvider = 'console';
    const res = await request(app).post('/api/v1/auth/register').send({ email: uniqueEmail('noemail'), password: PASSWORD, fullName: 'No Mail' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.emailCode).toEqual({ sent: false });
    expect(outbox).toHaveLength(0);
  });

  it('confirms its email with the code from the sign-up, and /me says so', async () => {
    const account = await softAccount();
    expect((await me(account.accessToken)).body.confirmed).toBe(false);

    const wrong = await confirmCode(account.accessToken, wrongCode(lastCode()));
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toMatchObject({ code: 'INVALID_CODE', details: { attemptsLeft: 4 } });

    const ok = await confirmCode(account.accessToken, lastCode());
    expect(ok.status).toBe(200);
    expect(ok.body.confirmed).toBe(true);
    expect(ok.body.user.emailVerifiedAt).toBeTruthy();
    expect(ok.body).not.toHaveProperty('accessToken');
    expect((await me(account.accessToken)).body.confirmed).toBe(true);

    const again = await confirmCode(account.accessToken, lastCode());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('sends a new code under the same limits, and none to a confirmed account', async () => {
    const account = await softAccount();
    const tooSoon = await sendCode(account.accessToken);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('RESEND_TOO_SOON');

    await db.sequelize.query(`UPDATE verification_codes SET created_at = created_at - interval '61 seconds' WHERE user_id = $id`, {
      bind: { id: account.userId },
    });
    const sent = await sendCode(account.accessToken, { locale: 'ar' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ sent: true, channel: 'email', target: `${account.email[0]}***@example.com` });
    expect(outbox[outbox.length - 1]).toMatchObject({ template: 'signup_code', data: { locale: 'ar' } });

    expect((await confirmCode(account.accessToken, lastCode())).status).toBe(200);
    const confirmed = await sendCode(account.accessToken);
    expect(confirmed.status).toBe(409);
  });
});

describe('what an unconfirmed account may not do', () => {
  it('publish or restore the website, publish or resume a funnel, or start a trial — and may do the rest', async () => {
    const account = await softAccount();
    const ws = await createWorkspace(account.accessToken, 'Soft Store');
    const site = await websiteWithPage(ws.id, account.H);
    const funnel = await funnelWithSteps(ws.id, account.H);
    const fake = '00000000-0000-4000-8000-000000000000';

    for (const res of await Promise.all([
      request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(account.H).send({}),
      request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/revisions/${fake}/rollback`).set(account.H).send({}),
      request(app).post(`/api/v1/workspaces/${ws.id}/funnels/${funnel.id}/publish`).set(account.H).send({}),
      request(app).post(`/api/v1/workspaces/${ws.id}/funnels/${funnel.id}/resume`).set(account.H).send({}),
      request(app).post(`/api/v1/workspaces/${ws.id}/funnels/${funnel.id}/revisions/${fake}/rollback`).set(account.H).send({}),
      request(app).post(`/api/v1/workspaces/${ws.id}/start-trial`).set(account.H).send({}),
    ])) {
      expectNotConfirmed(res, account.email);
    }

    // Building stays open.
    const product = await request(app).post(`/api/v1/workspaces/${ws.id}/catalog/products`).set(account.H).send({ name: 'Mug', status: 'active' });
    expect(product.status).toBe(201);

    // Confirmed: the same publish goes through, with what was built kept.
    expect((await confirmCode(account.accessToken, lastCode())).status).toBe(200);
    expect((await request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(account.H).send({})).status).toBe(201);
  });

  it('is asked to confirm before the draft-store refusal, so it confirms first and subscribes second', async () => {
    env.signup.requireSubscription = true;
    const account = await softAccount();
    const ws = await createWorkspace(account.accessToken, 'Draft Soft');
    const site = await websiteWithPage(ws.id, account.H);
    const publish = () => request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(account.H).send({});

    expectNotConfirmed(await publish(), account.email);
    await confirmCode(account.accessToken, lastCode());
    const draft = await publish();
    expect(draft.status).toBe(403);
    expect(draft.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('counts a confirmed phone as confirmed', async () => {
    const account = await softAccount();
    await db.User.update({ phoneVerifiedAt: new Date() }, { where: { id: account.userId } });
    const ws = await createWorkspace(account.accessToken, 'Phone Store');
    const site = await websiteWithPage(ws.id, account.H);
    expect((await me(account.accessToken)).body.confirmed).toBe(true);
    expect((await request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(account.H).send({})).status).toBe(201);
  });
});

describe('the quickstart form (it publishes)', () => {
  const FORM = { productName: 'Wonder Widget', price: '199.00', description: 'The best widget.' };
  const post = (wid, token, body) =>
    request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .type('form')
      .send({ ...FORM, token, ...body });

  it('asks for the code on the form, keeps what was typed, and publishes with the code in the same submit', async () => {
    const account = await softAccount();
    const ws = await createWorkspace(account.accessToken, 'Quick Soft');

    const refused = await post(ws.id, account.accessToken, {});
    expect(refused.status).toBe(403);
    expect(refused.text).toMatch(/Confirm your email address to publish/);
    expect(refused.text).toContain('name="verificationCode"');
    expect(refused.text).toContain('value="Wonder Widget"');
    expect(refused.text).toContain(`value="${account.accessToken}"`);
    expect(await db.Product.count({ where: { workspaceId: ws.id } })).toBe(0);

    await db.sequelize.query(`UPDATE verification_codes SET created_at = created_at - interval '61 seconds' WHERE user_id = $id`, {
      bind: { id: account.userId },
    });
    const sent = await post(ws.id, account.accessToken, { intent: 'send_code' });
    expect(sent.status).toBe(200);
    expect(sent.text).toMatch(/We sent a 6-digit code/);
    expect(sent.text).toContain('value="Wonder Widget"');

    const wrong = await post(ws.id, account.accessToken, { verificationCode: wrongCode(lastCode()) });
    expect(wrong.status).toBe(422);
    expect(wrong.text).toContain('value="Wonder Widget"');

    const published = await post(ws.id, account.accessToken, { verificationCode: lastCode() });
    expect(published.status).toBe(200);
    expect(published.text).toMatch(/live/i);
    expect((await db.User.findByPk(account.userId)).emailVerifiedAt).toBeTruthy();
    expect(await db.Product.count({ where: { workspaceId: ws.id } })).toBe(1);
  });
});

describe('access that used to rely on "active" meaning "confirmed"', () => {
  it('a console role needs a confirmed account', async () => {
    const creator = await makePlatformUser('creator');
    const account = await softAccount();
    const grant = () =>
      request(app).post('/api/v1/admin/admins').set(bearer(creator.accessToken)).send({ email: account.email, role: 'admin' });
    const refused = await grant();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('USER_NOT_ACTIVE');

    await confirmCode(account.accessToken, lastCode());
    expect((await grant()).status).toBe(201);
  });

  it('a store invitation to an existing account needs it confirmed', async () => {
    const owner = await registerAndActivate();
    const ws = await createWorkspace(owner.accessToken, 'Team Store');
    const role = await db.Role.findOne({ where: { workspaceId: ws.id, key: 'order_operator' } });
    const account = await softAccount();
    const invite = () =>
      request(app).post(`/api/v1/workspaces/${ws.id}/members`).set(bearer(owner.accessToken)).send({ email: account.email, roleId: role.id });

    const refused = await invite();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVITEE_NOT_CONFIRMED');
    expect(await db.Membership.count({ where: { workspaceId: ws.id, userId: account.userId } })).toBe(0);

    await confirmCode(account.accessToken, lastCode());
    expect((await invite()).status).toBe(201);
  });
});
