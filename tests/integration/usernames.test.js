'use strict';

// Usernames (migration 124, modules/users): the rules, uniqueness regardless
// of case (also for two sign-ups racing), the reserved list, the live
// availability check and its rate limit, changing one (once per 30 days),
// accounts made through Google, and the backfill of existing accounts.

jest.mock('../../src/modules/auth/googleClient', () => ({
  getAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
  fetchProfile: jest.fn(),
}));
const googleClient = require('../../src/modules/auth/googleClient');

const express = require('express');
const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const { createUsernameCheckLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { backfill } = require('../../src/db/migrations/124-add-usernames-and-user-search');
const { usernameProblem } = require('../../src/modules/users/username');

let seq = 0;
const email = (prefix = 'u') => `${prefix}${Date.now()}${(seq += 1)}@example.com`;
const register = (body) =>
  request(app)
    .post('/api/v1/auth/register')
    .send({ email: email(), password: 'Passw0rd!123', fullName: 'Name Here', ...body });

async function signedIn(body = {}) {
  const res = await register(body);
  expect(res.status).toBe(201);
  await db.User.update({ status: 'active', emailVerifiedAt: new Date() }, { where: { id: res.body.user.id } });
  return { id: res.body.user.id, H: { Authorization: `Bearer ${res.body.accessToken}` }, username: res.body.user.username };
}

describe('usernames at sign-up', () => {
  it('stores it lower-case and returns it, with the id, from /me', async () => {
    const me = await signedIn({ username: 'Sara.Ali_1' });
    expect(me.username).toBe('sara.ali_1');
    const res = await request(app).get('/api/v1/auth/me').set(me.H);
    expect(res.body.user).toMatchObject({ id: me.id, username: 'sara.ali_1' });
    expect(res.body.suggestedUsername).toBeUndefined();
  });

  it('is unique regardless of case', async () => {
    await signedIn({ username: 'mona.adel' });
    const clash = await register({ username: 'MONA.ADEL' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('lets exactly one of two simultaneous sign-ups have the same name', async () => {
    const [a, b] = await Promise.all([register({ username: 'racer.one' }), register({ username: 'racer.one' })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db.User.count({ where: { username: 'racer.one' } })).toBe(1);
  });

  it('refuses reserved names and anything outside the rules', async () => {
    for (const name of ['admin', 'Support', 'zimos', 'checkout', 'null']) {
      const res = await register({ username: name });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/reserved/);
    }
    for (const name of ['ab', '1abc', 'abc.', 'abc_', 'a..bc', 'ab-c', 'اسم', 'a'.repeat(31)]) {
      expect((await register({ username: name })).status).toBe(422);
    }
    expect((await register({ username: 'a_b.c1' })).status).toBe(201);
  });

  it('gives one from the email to a sign-up that sends none (an older client)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: `hana.k+shop${Date.now()}@example.com`, password: 'Passw0rd!123', fullName: 'Hana' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toMatch(/^hana\.kshop\d+$/);
  });
});

describe('GET /auth/username-available', () => {
  const check = (u) => request(app).get('/api/v1/auth/username-available').query({ u });

  it('says available, taken, reserved or invalid — and nothing else', async () => {
    await signedIn({ username: 'taken.name' });
    expect((await check('free.name')).body).toEqual({ available: true });
    expect((await check('Taken.Name')).body).toEqual({ available: false, reason: 'taken' });
    expect((await check('admin')).body).toEqual({ available: false, reason: 'reserved' });
    expect((await check('no')).body).toEqual({ available: false, reason: 'invalid' });
  });

  it('is rate limited per IP', async () => {
    const limited = express();
    limited.set('trust proxy', 1);
    limited.get('/check', createUsernameCheckLimiter({ minuteMax: 3, hourMax: 100 }), (req, res) => res.json({ ok: true }));
    limited.use(errorHandler);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await request(limited).get('/check').set('X-Forwarded-For', '198.51.100.4')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await request(limited).get('/check').set('X-Forwarded-For', '198.51.100.5')).status).toBe(200);
  });
});

describe('changing a username', () => {
  const change = (H, username) => request(app).patch('/api/v1/auth/me/username').set(H).send({ username });

  it('allows one change per 30 days, and frees the old name', async () => {
    const me = await signedIn({ username: 'first.name' });
    const first = await change(me.H, 'second.name');
    expect(first.status).toBe(200);
    expect(first.body.user.username).toBe('second.name');

    const tooSoon = await change(me.H, 'third.name');
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.code).toBe('USERNAME_CHANGE_TOO_SOON');
    expect(tooSoon.body.error.details.nextChangeAt).toBeTruthy();

    // The old name is anyone's again.
    const other = await signedIn();
    expect((await change(other.H, 'first.name')).status).toBe(200);

    await db.User.update({ usernameChangedAt: new Date(Date.now() - 31 * 86400000) }, { where: { id: me.id } });
    expect((await change(me.H, 'third.name')).status).toBe(200);
  });

  it('refuses a taken, reserved or malformed name', async () => {
    await signedIn({ username: 'holder.one' });
    const me = await signedIn();
    expect((await change(me.H, 'HOLDER.ONE')).status).toBe(409);
    expect((await change(me.H, 'billing')).status).toBe(422);
    expect((await change(me.H, 'bad name')).status).toBe(422);
  });
});

describe('accounts made through Google', () => {
  it('start with no username, get a suggestion, and choose one freely', async () => {
    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: `g-${Date.now()}`,
      email: `layla.g${Date.now()}@example.com`,
      emailVerified: true,
      fullName: 'Layla G',
    });
    const res = await request(app).get('/api/v1/auth/google/callback?code=x').redirects(0);
    const token = new URL(res.headers.location, 'http://x').searchParams.get('accessToken');
    const H = { Authorization: `Bearer ${token}` };

    const me = await request(app).get('/api/v1/auth/me').set(H);
    expect(me.body.user.username).toBeNull();
    expect(me.body.suggestedUsername).toMatch(/^layla\.g\d+$/);

    const chosen = await request(app).patch('/api/v1/auth/me/username').set(H).send({ username: me.body.suggestedUsername });
    expect(chosen.status).toBe(200);
    // The first choice is not a change: the 30 days have not started.
    expect((await db.User.findByPk(me.body.user.id)).usernameChangedAt).toBeNull();
    expect((await request(app).patch('/api/v1/auth/me/username').set(H).send({ username: 'layla.other' })).status).toBe(200);
  });
});

describe('backfill (migration 124)', () => {
  it('gives every existing account a valid, unique username from its email', async () => {
    const stamp = Date.now();
    const emails = [
      `john@a${stamp}.com`,
      `JOHN@b${stamp}.com`,
      `john@c${stamp}.com`,
      `admin@d${stamp}.com`,
      `12@e${stamp}.com`,
      `mary-jane_o.neil_@f${stamp}.com`,
      `x@g${stamp}.com`,
    ];
    for (const e of emails) await db.User.create({ email: e, fullName: 'Old Account', passwordHash: null, status: 'active' });
    // Someone already holds "john".
    await db.User.update({ username: null }, { where: { email: emails } });
    await signedIn({ username: 'john' });

    await backfill(db.sequelize.getQueryInterface());

    const users = await db.User.findAll({ where: { email: emails } });
    const names = users.map((u) => u.username);
    expect(names.every((n) => n && !usernameProblem(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('john');
    expect(names).not.toContain('admin');
    expect(names.filter((n) => n.startsWith('john_'))).toHaveLength(3);
    expect(await db.User.count({ where: { username: null } })).toBe(0);
  });
});
