'use strict';

// Anonymous marketing-site analytics (siteAnalytics/): the public beacon and
// its flag, origin, bot, body and rate-limit checks; the console summary; and
// sign-up linking the session and keeping the account's first source.

const express = require('express');
const { QueryTypes } = require('sequelize');
const { app, request, uniqueEmail, makePlatformUser, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const siteTraffic = require('../../src/modules/siteAnalytics/siteTrafficService');
const { createSiteEventsRouter } = require('../../src/modules/siteAnalytics/siteEventsRoutes');
const { createIpMinuteLimiter } = require('../../src/core/middleware/rateLimiters');
const { resolveClientIp } = require('../../src/core/middleware/clientIp');
const { errorHandler, notFoundHandler } = require('../../src/core/middleware/errorHandler');

const URL = '/api/v1/public/site-events';
const ORIGIN = 'https://zimos.co';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const rows = () => db.sequelize.query('SELECT * FROM site_visits ORDER BY created_at, id', { type: QueryTypes.SELECT });

function send(body, { origin = ORIGIN, ua = CHROME, ip } = {}) {
  let req = request(app).post(URL).set('User-Agent', ua).set('Content-Type', 'text/plain');
  if (origin) req = req.set('Origin', origin);
  if (ip) req = req.set('X-Forwarded-For', ip);
  return req.send(JSON.stringify(body));
}

const view = (over = {}) => ({ visitorId: 'visitor-aaaa-1111', sessionId: 'session-aaaa-1111', event: 'view', path: '/', locale: 'en', ...over });

beforeEach(async () => {
  env.siteAnalytics.enabled = true;
  env.siteAnalytics.origins = [ORIGIN];
  await db.sequelize.query('DELETE FROM user_acquisition');
  await db.sequelize.query('DELETE FROM site_visits');
});

afterEach(() => {
  env.siteAnalytics.enabled = false;
  env.siteAnalytics.origins = [];
  jest.restoreAllMocks();
});

describe('POST /public/site-events', () => {
  it('answers 404 like an unknown path while the flag is off, and stores nothing', async () => {
    env.siteAnalytics.enabled = false;
    const res = await send(view());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it('stores a view with a daily hash, the referrer host and the device, and no IP', async () => {
    const res = await send(view({ referrer: 'https://www.google.com/search?q=zimos', utmSource: 'fb', utmCampaign: 'launch' }), { ip: '203.0.113.9' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);

    const [row] = await rows();
    expect(row).toMatchObject({
      session_id: 'session-aaaa-1111',
      path: '/',
      locale: 'en',
      referrer_host: 'www.google.com',
      utm_source: 'fb',
      utm_campaign: 'launch',
      device_class: 'desktop',
      country: null,
      event: 'view',
      seconds_on_page: 0,
      user_id: null,
    });
    expect(row.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.visitor_hash).toBe(siteTraffic.visitorHash('visitor-aaaa-1111'));
    expect(row.visitor_hash).not.toBe(siteTraffic.visitorHash('visitor-aaaa-1111', new Date(Date.now() - 86400000)));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('203.0.113.9');
    expect(stored).not.toContain('127.0.0.1');
    expect(stored).not.toContain('visitor-aaaa-1111');
    expect(stored).not.toContain('q=zimos');
  });

  it('counts a ping as the server-side interval, whatever the client sends', async () => {
    const res = await send({ ...view({ event: 'ping' }) });
    expect(res.status).toBe(204);
    const [row] = await rows();
    expect(row.seconds_on_page).toBe(siteTraffic.PING_SECONDS);
  });

  it('answers a known bot 204 and stores nothing', async () => {
    const res = await send(view(), { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses unknown keys, client times, long values, a client signup event, a big body and other origins', async () => {
    const cases = [
      view({ ip: '1.2.3.4' }),
      view({ ts: Date.now() }),
      view({ seconds: 900 }),
      view({ path: `/${'a'.repeat(400)}` }),
      view({ path: 'https://evil.example/' }),
      view({ event: 'signup' }),
      view({ utmSource: 'x'.repeat(101) }),
      view({ visitorId: 'short' }),
      { ...view(), sessionId: undefined },
    ];
    for (const body of cases) {
      const res = await send(body);
      expect(res.status).toBe(422);
    }
    expect((await send(view({ referrer: 'x'.repeat(3000) }))).status).toBe(413);
    expect((await send(view(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send(view(), { origin: null })).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it('limits each IP per minute', async () => {
    const mini = express();
    mini.use(resolveClientIp);
    mini.use(URL, createSiteEventsRouter({ limiter: createIpMinuteLimiter('site-events-test', 2) }));
    mini.use(notFoundHandler);
    mini.use(errorHandler);
    const post = () => request(mini).post(URL).set('Origin', ORIGIN).set('User-Agent', CHROME).set('Content-Type', 'text/plain').send(JSON.stringify(view()));
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(429);
    expect(await rows()).toHaveLength(2);
  });
});

describe('sign-up linking', () => {
  const register = (extra = {}) =>
    request(app)
      .post('/api/v1/auth/register')
      .send({ phone: '01012345678', email: uniqueEmail('site'), password: 'Passw0rd!123', fullName: 'Site Visitor', ...extra });

  it('links the session, adds a signup row and keeps the first source; the user page shows it', async () => {
    const sid = 'session-link-0001';
    await send(view({ sessionId: sid, path: '/pricing', utmSource: 'newsletter', utmMedium: 'email' }));
    await send(view({ sessionId: sid, event: 'cta_click', path: '/pricing' }));
    await send(view({ sessionId: 'someone-else-0001' }));

    const res = await register({ siteSessionId: sid });
    expect(res.status).toBe(201);
    const userId = res.body.user.id;

    const linked = await db.sequelize.query('SELECT event, user_id FROM site_visits WHERE session_id = :sid ORDER BY created_at, id', {
      replacements: { sid },
      type: QueryTypes.SELECT,
    });
    expect(linked.map((r) => r.event)).toEqual(['view', 'cta_click', 'signup']);
    expect(linked.every((r) => r.user_id === userId)).toBe(true);
    const other = await db.sequelize.query("SELECT user_id FROM site_visits WHERE session_id = 'someone-else-0001'", { type: QueryTypes.SELECT });
    expect(other[0].user_id).toBeNull();

    const acquisition = await siteTraffic.acquisitionFor(userId);
    expect(acquisition).toMatchObject({ landingPath: '/pricing', utmSource: 'newsletter', utmMedium: 'email', referrerHost: null });
    expect(acquisition.secondsBeforeSignup).toBeGreaterThanOrEqual(0);

    const creator = await makePlatformUser('creator');
    const detail = await request(app).get(`/api/v1/admin/users/${userId}`).set(creator.H);
    expect(detail.status).toBe(200);
    expect(detail.body.user.acquisition).toMatchObject({ landingPath: '/pricing', utmSource: 'newsletter' });
  });

  it('ignores siteSessionId while the flag is off, and a session with no visits', async () => {
    await send(view({ sessionId: 'session-off-0001' }));
    env.siteAnalytics.enabled = false;
    const off = await register({ siteSessionId: 'session-off-0001' });
    expect(off.status).toBe(201);
    expect(await siteTraffic.acquisitionFor(off.body.user.id)).toBeNull();

    env.siteAnalytics.enabled = true;
    const none = await register({ siteSessionId: 'session-none-0001' });
    expect(none.status).toBe(201);
    expect(await siteTraffic.acquisitionFor(none.body.user.id)).toBeNull();
  });

  it('refuses a malformed siteSessionId like any other field', async () => {
    const res = await register({ siteSessionId: 'bad id!' });
    expect(res.status).toBe(422);
  });

  it('never fails sign-up when analytics fails', async () => {
    await send(view({ sessionId: 'session-boom-0001' }));
    jest.spyOn(siteTraffic, 'linkSession').mockRejectedValue(new Error('analytics down'));
    const res = await register({ siteSessionId: 'session-boom-0001' });
    expect(res.status).toBe(201);
    expect(await siteTraffic.acquisitionFor(res.body.user.id)).toBeNull();
  });
});

describe('GET /admin/site-traffic/summary', () => {
  it('counts visits, visitors, time, pages, sources, the funnel and the days', async () => {
    await send(view({ visitorId: 'visitor-one-0001', sessionId: 'session-one-0001', path: '/', referrer: 'https://facebook.com/x' }));
    await send(view({ visitorId: 'visitor-one-0001', sessionId: 'session-one-0001', event: 'ping' }));
    await send(view({ visitorId: 'visitor-one-0001', sessionId: 'session-one-0001', event: 'ping' }));
    await send(view({ visitorId: 'visitor-one-0001', sessionId: 'session-one-0001', path: '/pricing' }));
    await send(view({ visitorId: 'visitor-one-0001', sessionId: 'session-one-0001', event: 'cta_click', path: '/pricing' }));
    await send(view({ visitorId: 'visitor-two-0002', sessionId: 'session-two-0002', path: '/', utmSource: 'google' }), { ua: IPHONE });
    const signup = await request(app)
      .post('/api/v1/auth/register')
      .send({ phone: '01012345678', email: uniqueEmail('sum'), password: 'Passw0rd!123', fullName: 'Summed', siteSessionId: 'session-one-0001' });
    expect(signup.status).toBe(201);

    const admin = await makePlatformUser('admin');
    const res = await request(app).get('/api/v1/admin/site-traffic/summary?range=today').set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      range: 'today',
      visits: 3,
      uniqueVisitors: 2,
      avgSecondsOnSite: siteTraffic.PING_SECONDS, // 30 seconds over 2 sessions
      funnel: { visit: 2, ctaClick: 1, signup: 1 },
    });
    expect(res.body.topPages).toEqual([
      { path: '/', visits: 2 },
      { path: '/pricing', visits: 1 },
    ]);
    expect(res.body.topSources).toEqual([
      { source: 'facebook.com', sessions: 1 },
      { source: 'google', sessions: 1 },
    ]);
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.daily[0]).toMatchObject({ visits: 3, uniqueVisitors: 2 });

    const week = await request(app).get('/api/v1/admin/site-traffic/summary?range=7d').set(admin.H);
    expect(week.body.daily).toHaveLength(7);
    expect(week.body.daily[6]).toMatchObject({ visits: 3 });
    expect(week.body.daily.slice(0, 6).every((d) => d.visits === 0)).toBe(true);

    const bad = await request(app).get('/api/v1/admin/site-traffic/summary?range=year').set(admin.H);
    expect(bad.status).toBe(422);
  });

  it('is for console admins only', async () => {
    const merchant = await registerAndActivate();
    const res = await request(app).get('/api/v1/admin/site-traffic/summary').set('Authorization', `Bearer ${merchant.accessToken}`);
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/v1/admin/site-traffic/summary')).status).toBe(401);
  });
});
