'use strict';

// A plan (and the terms) at sign-up — REQUIRE_PLAN_AT_SIGNUP
// (auth/signupPolicy) — and the plan reaching the first store.

jest.mock('../../src/modules/auth/googleClient', () => ({
  getAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
  fetchProfile: jest.fn(),
}));
const googleClient = require('../../src/modules/auth/googleClient');

const { app, request, uniqueEmail, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { TERMS_VERSION } = require('../../src/modules/auth/signupPolicy');

const ORIGINAL_SIGNUP = { ...env.signup };
afterEach(() => {
  Object.assign(env.signup, ORIGINAL_SIGNUP);
  googleClient.fetchProfile.mockReset();
});

let seq = 0;
function plan(overrides = {}) {
  seq += 1;
  return db.Plan.create({
    key: `signup-${seq}`,
    name: `Signup ${seq}`,
    monthlyPriceAmount: 29900,
    yearlyPriceAmount: 299000,
    currency: 'EGP',
    trialDays: 14,
    features: [],
    isActive: true,
    isPublic: true,
    ...overrides,
  });
}

const form = (overrides = {}) => ({
  email: uniqueEmail('signup'),
  password: 'Passw0rd!123',
  fullName: 'New Merchant',
  ...overrides,
});
const register = (body) => request(app).post('/api/v1/auth/register').send({ phone: '01012345678', ...body });
const activate = (email) => db.User.update({ status: 'active', emailVerifiedAt: new Date() }, { where: { email } });
// An account made the way they were before the flag was turned on.
async function existingAccount() {
  const on = env.signup.requirePlan;
  env.signup.requirePlan = false;
  try {
    return await registerAndActivate();
  } finally {
    env.signup.requirePlan = on;
  }
}
const signIn = async (email) =>
  (await request(app).post('/api/v1/auth/login').send({ email, password: 'Passw0rd!123' })).body;

describe('with REQUIRE_PLAN_AT_SIGNUP off', () => {
  it('signs up exactly as before: no plan, no terms, tokens back', async () => {
    await plan();
    const res = await register(form());
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.selectedPlanId).toBeNull();
    // Active at once, its email still to confirm (soft confirmation).
    expect(res.body.user.status).toBe('active');
    expect(res.body.user.emailVerifiedAt).toBeNull();
  });

  it('ignores a plan sent anyway: the first store gets the default plan', async () => {
    const cheap = await plan({ monthlyPriceAmount: 0, isPublic: false });
    const chosen = await plan();
    const body = form({ planId: chosen.id });
    expect((await register(body)).status).toBe(201);
    await activate(body.email);
    const { accessToken } = await signIn(body.email);
    const ws = await createWorkspace(accessToken, 'Old way');
    const sub = await db.Subscription.findOne({ where: { workspaceId: ws.id } });
    expect(sub.planId).toBe(cheap.id);
    expect(sub.status).toBe('trialing');
  });

  it('records the terms when the form sends them', async () => {
    const res = await register(form({ acceptTerms: true }));
    expect(res.body.user.termsVersion).toBe(TERMS_VERSION);
    expect(res.body.user.termsAcceptedAt).toBeTruthy();
  });

  it('says nothing is required', async () => {
    const res = await request(app).get('/api/v1/auth/signup-options');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ planRequired: false, termsRequired: false, termsVersion: TERMS_VERSION, verificationRequired: false });
  });
});

describe('with REQUIRE_PLAN_AT_SIGNUP on', () => {
  beforeEach(() => {
    env.signup.requirePlan = true;
  });

  it('signs up with a public plan and the terms, and the first store starts on that plan', async () => {
    await plan({ monthlyPriceAmount: 0 }); // the cheapest: what the store would get otherwise
    const chosen = await plan({ name: 'Growth', monthlyPriceAmount: 79900 });
    const body = form({ planId: chosen.id, billingCycle: 'yearly', acceptTerms: true });
    const res = await register(body);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ selectedPlanId: chosen.id, selectedBillingCycle: 'yearly', termsVersion: TERMS_VERSION });

    await activate(body.email);
    const { accessToken } = await signIn(body.email);
    const first = await createWorkspace(accessToken, 'First store');
    const sub = await db.Subscription.findOne({ where: { workspaceId: first.id } });
    expect(sub).toMatchObject({ planId: chosen.id, billingCycle: 'yearly', status: 'trialing' });
    // Only the first store: a second gets the default.
    const second = await createWorkspace(accessToken, 'Second store');
    expect((await db.Subscription.findOne({ where: { workspaceId: second.id } })).planId).not.toBe(chosen.id);
  });

  it('refuses a sign-up without a plan: 422 PLAN_REQUIRED', async () => {
    await plan();
    const res = await register(form({ acceptTerms: true }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLAN_REQUIRED');
    expect(await db.User.count()).toBe(0);
  });

  it.each([
    ['private', { isPublic: false }],
    ['inactive', { isActive: false }],
  ])('refuses a %s plan: 422 PLAN_NOT_AVAILABLE', async (label, overrides) => {
    await plan();
    const hidden = await plan(overrides);
    const res = await register(form({ planId: hidden.id, acceptTerms: true }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLAN_NOT_AVAILABLE');
  });

  it('refuses a sign-up without the terms: 422 TERMS_REQUIRED', async () => {
    const p = await plan();
    const res = await register(form({ planId: p.id }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TERMS_REQUIRED');
  });

  it('stays open without a plan while no plan is public, still asking for the terms', async () => {
    await plan({ isPublic: false });
    expect((await register(form())).body.error.code).toBe('TERMS_REQUIRED');
    const res = await register(form({ acceptTerms: true }));
    expect(res.status).toBe(201);
    expect(res.body.user.selectedPlanId).toBeNull();
    const options = (await request(app).get('/api/v1/auth/signup-options')).body;
    expect(options).toMatchObject({ planRequired: false, termsRequired: true });
  });

  it('does not ask someone invited to a store for a plan', async () => {
    await plan();
    const owner = await existingAccount();
    const ws = await createWorkspace(owner.accessToken, 'Team store');
    const role = await db.Role.findOne({ where: { workspaceId: ws.id, key: 'order_operator' } });
    const invited = uniqueEmail('staff');
    await request(app)
      .post(`/api/v1/workspaces/${ws.id}/members`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ email: invited, roleId: role.id });
    const res = await register(form({ email: invited, acceptTerms: true }));
    expect(res.status).toBe(201);
  });

  it('leaves accounts from before the flag alone', async () => {
    const before = await existingAccount();
    await plan();
    const me = await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${before.accessToken}` });
    expect(me.body.needsPlan).toBe(false);
    expect((await createWorkspace(before.accessToken, 'Still fine')).id).toBeTruthy();
  });

  it('refuses a store on a plan that is not offered', async () => {
    await plan();
    const hidden = await plan({ isPublic: false });
    const owner = await existingAccount();
    const res = await request(app)
      .post('/api/v1/workspaces')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ name: 'Sneaky', planId: hidden.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLAN_NOT_AVAILABLE');
  });
});

describe('Google accounts', () => {
  const googleLogin = async (email) => {
    googleClient.fetchProfile.mockResolvedValueOnce({ googleId: `g-${email}`, email, emailVerified: true, fullName: 'G User' });
    const res = await require('../helpers/googleSignIn').googleCallback('code=x');
    return new URL(res.headers.location, 'http://x').searchParams.get('accessToken');
  };

  it('must choose a plan after signing in while one is required — and then may', async () => {
    env.signup.requirePlan = true;
    const p = await plan();
    const email = uniqueEmail('google');
    const token = await googleLogin(email);
    const H = { Authorization: `Bearer ${token}` };

    const me = await request(app).get('/api/v1/auth/me').set(H);
    expect(me.body.needsPlan).toBe(true);
    expect(me.body.user.emailVerifiedAt).toBeTruthy();

    // No store until a plan is chosen.
    const early = await request(app).post('/api/v1/workspaces').set(H).send({ name: 'Too early' });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PLAN_REQUIRED');

    expect((await request(app).post('/api/v1/auth/me/plan').set(H).send({ planId: p.id })).body.error.code).toBe('TERMS_REQUIRED');
    const chose = await request(app).post('/api/v1/auth/me/plan').set(H).send({ planId: p.id, acceptTerms: true });
    expect(chose.status).toBe(200);
    expect(chose.body.needsPlan).toBe(false);
    expect(chose.body.user).toMatchObject({ selectedPlanId: p.id, termsVersion: TERMS_VERSION });
    const ws = await createWorkspace(token, 'Google store');
    expect((await db.Subscription.findOne({ where: { workspaceId: ws.id } })).planId).toBe(p.id);
    expect(await db.AuditLog.count({ where: { action: 'user.plan_select' } })).toBe(1);
  });

  it('is never asked with the flag off', async () => {
    await plan();
    const token = await googleLogin(uniqueEmail('google'));
    const me = await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${token}` });
    expect(me.body.needsPlan).toBe(false);
    expect(me.body.user.requiresPlanSelection).toBe(false);
  });
});
