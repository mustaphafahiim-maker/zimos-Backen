'use strict';

// Web analytics over analytics_events / analytics_sessions (Umami port):
// ingest-derived columns, stats, series, metrics, weekly and realtime.
// Ported from the zimos-additions branch. Visitor geo is read from CDN
// headers only for the CDNs env.analytics.geoHeaders trusts; this suite
// trusts Cloudflare's (analyticsAccess.test.js checks the untrusted default).

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const trustedGeoBefore = env.analytics.geoHeaders;
beforeAll(() => {
  env.analytics.geoHeaders = ['cloudflare'];
});
afterAll(() => {
  env.analytics.geoHeaders = trustedGeoBefore;
});

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const MIN = 60 * 1000;
const ago = (minutes, now) => new Date(now.getTime() - minutes * MIN).toISOString();

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Acme Web Analytics');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/analytics/web`;
  return {
    auth,
    workspace,
    H,
    post: (body, ua = CHROME_UA, headers = {}, wid = workspace.id) =>
      request(app).post(`/api/v1/store/${wid}/events`).set('User-Agent', ua).set(headers).send(body),
    get: (path, q = {}) => request(app).get(`${base}/${path}`).set(H).query(q),
  };
}

/**
 * Seeds three sessions:
 *  A chrome/laptop  : google -> "/" then "/products/hat" (same-origin ref) + add_to_cart, 10..9 min ago
 *  B iphone/mobile  : "/" 40 min ago and "/" 4 min ago  -> two visits (31+ min gap)
 *  C firefox/desktop: facebook -> "/about" 3 min ago, with cf-ipcountry: EG
 */
async function seed(ctx, now) {
  const common = { hostname: 'www.shop.example.com' };
  let res = await ctx.post({
    ...common,
    visitorId: 'visitor-a',
    sessionId: 'session-aaaa',
    screen: '1920x1080',
    language: 'en-US',
    events: [
      { name: 'page_view', url: 'https://www.shop.example.com/', title: 'Home', referrer: 'https://www.google.com/', occurredAt: ago(10, now) },
      { name: 'page_view', url: '/products/hat?utm_content=c1&utm_term=hats', title: 'Hat', referrer: '/', occurredAt: ago(9, now) },
      { name: 'add_to_cart', url: '/products/hat', tag: 'cart', currency: 'EGP', data: { sku: 'HAT-1' }, occurredAt: ago(9, now) },
    ],
  });
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ accepted: 3 });

  res = await ctx.post({ ...common, visitorId: 'visitor-b', sessionId: 'session-bbbb', screen: '390x844', language: 'ar-EG', events: [{ name: 'page_view', url: '/', occurredAt: ago(40, now) }] }, IPHONE_UA);
  expect(res.status).toBe(202);
  res = await ctx.post({ ...common, visitorId: 'visitor-b', sessionId: 'session-bbbb', screen: '390x844', language: 'ar-EG', events: [{ name: 'page_view', url: '/', occurredAt: ago(4, now) }] }, IPHONE_UA);
  expect(res.status).toBe(202);

  res = await ctx.post(
    { ...common, visitorId: 'visitor-c', sessionId: 'session-cccc', language: 'fr', events: [{ name: 'page_view', url: '/about', referrer: 'https://facebook.com/some/post', occurredAt: ago(3, now) }] },
    FIREFOX_UA,
    { 'cf-ipcountry': 'EG', 'cf-region-code': 'C', 'cf-ipcity': 'Cairo' }
  );
  expect(res.status).toBe(202);
}

describe('web analytics (Umami port)', () => {
  it('ingest derives page/referrer/utm columns, sessions and visits', async () => {
    const ctx = await setup();
    const now = new Date();
    await seed(ctx, now);

    const rows = await db.AnalyticsEvent.findAll({ where: { workspaceId: ctx.workspace.id }, order: [['createdAt', 'ASC'], ['eventName', 'ASC']], raw: true });
    expect(rows).toHaveLength(6);

    const home = rows.find((r) => r.sessionId === 'session-aaaa' && r.urlPath === '/');
    expect(home).toMatchObject({ eventType: 1, hostname: 'shop.example.com', pageTitle: 'Home', referrerDomain: 'google.com', referrerPath: '/', screen: '1920x1080', language: 'en-US' });
    const hat = rows.find((r) => r.eventName === 'page_view' && r.urlPath === '/products/hat');
    expect(hat).toMatchObject({ urlQuery: 'utm_content=c1&utm_term=hats', utmContent: 'c1', utmTerm: 'hats', referrerDomain: null, referrerPath: '/' });
    const cart = rows.find((r) => r.eventName === 'add_to_cart');
    expect(cart).toMatchObject({ eventType: 2, tag: 'cart', currency: 'EGP' });
    expect(cart.metadata).toEqual({ device: 'laptop', data: { sku: 'HAT-1' } });
    expect(home.visitId).toBe(hat.visitId);
    expect(cart.visitId).toBe(hat.visitId);

    // 31+ minute gap -> two visits on the same session.
    const b = rows.filter((r) => r.sessionId === 'session-bbbb');
    expect(b).toHaveLength(2);
    expect(b[0].visitId).not.toBe(b[1].visitId);

    const sessions = await db.AnalyticsSession.findAll({ where: { workspaceId: ctx.workspace.id }, order: [['id', 'ASC']], raw: true });
    expect(sessions.map((s) => [s.id, s.browser, s.os, s.device, s.screen, s.language, s.country, s.region, s.city])).toEqual([
      ['session-aaaa', 'chrome', 'Windows 10', 'laptop', '1920x1080', 'en-US', null, null, null],
      ['session-bbbb', 'ios', 'iOS', 'mobile', '390x844', 'ar-EG', null, null, null],
      ['session-cccc', 'firefox', 'Linux', 'desktop', null, 'fr', 'EG', 'EG-C', 'Cairo'],
    ]);
    expect(sessions.find((s) => s.id === 'session-bbbb').currentVisitId).toBe(b[1].visitId);
  });

  it('stores nothing for bot user agents', async () => {
    const ctx = await setup();
    const res = await ctx.post({ visitorId: 'visitor-bot', sessionId: 'session-bot1', events: [{ name: 'page_view', url: '/' }] }, BOT_UA);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 0, bot: true });
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
    expect(await db.AnalyticsSession.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });

  it('stats: pageviews, visitors, visits, bounces, bounce rate, avg visit time (+ compare=prev)', async () => {
    const ctx = await setup();
    const now = new Date();
    await seed(ctx, now);

    let res = await ctx.get('stats');
    expect(res.status).toBe(200);
    // 5 pageviews / 3 sessions / 4 visits; A's visit lasted 60s and has a custom event, the other 3 bounced.
    expect(res.body).toEqual({ pageviews: 5, visitors: 3, visits: 4, bounces: 3, totaltime: 60, bounceRate: 75, avgVisitTime: 15 });

    res = await ctx.get('stats', { compare: 'prev' });
    expect(res.status).toBe(200);
    expect(res.body.pageviews).toBe(5);
    // Nothing happened in the previous window, so the rates have no value —
    // not a zero, which would read as "nobody bounced".
    expect(res.body.comparison).toEqual({ pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0, bounceRate: null, avgVisitTime: null });

    res = await ctx.get('stats', { compare: 'yoy' });
    expect(res.body.comparison.pageviews).toBe(0);

    // Filters narrow: only the firefox session.
    res = await ctx.get('stats', { browser: 'firefox' });
    expect(res.body).toMatchObject({ pageviews: 1, visitors: 1, visits: 1, bounces: 1 });
    res = await ctx.get('stats', { browser: ['firefox', 'chrome'] });
    expect(res.body).toMatchObject({ pageviews: 3, visitors: 2 });
    res = await ctx.get('stats', { url: '/about' });
    expect(res.body).toMatchObject({ pageviews: 1, visitors: 1 });

    // Another workspace sees nothing.
    const other = await setup();
    res = await other.get('stats');
    expect(res.body).toMatchObject({ pageviews: 0, visitors: 0, visits: 0 });

    res = await ctx.get('stats', { from: 'nope' });
    expect(res.status).toBe(422);
  });

  it('series: hourly buckets with zeros filled', async () => {
    const ctx = await setup();
    const now = new Date();
    await seed(ctx, now);

    const from = new Date(now.getTime() - 3 * 60 * MIN);
    const res = await ctx.get('series', { from: from.toISOString(), to: now.toISOString(), tz: 'UTC' });
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe('hour');
    expect(res.body.series).toHaveLength(4);
    for (const b of res.body.series) {
      expect(new Date(b.t).getUTCMinutes()).toBe(0);
    }
    expect(res.body.series[0].t).toBe(new Date(Math.floor(from.getTime() / (60 * MIN)) * 60 * MIN).toISOString());
    expect(res.body.series.reduce((s, b) => s + b.pageviews, 0)).toBe(5);
    expect(res.body.series.filter((b) => b.pageviews === 0).length).toBeGreaterThanOrEqual(2);

    const cmp = await ctx.get('series', { from: from.toISOString(), to: now.toISOString(), compare: 'prev', unit: 'hour' });
    expect(cmp.body.comparison).toHaveLength(4);
    expect(cmp.body.comparison.every((b) => b.pageviews === 0)).toBe(true);
  });

  it('metrics: path / referrer / browser / device / country / event / channel / entry / language', async () => {
    const ctx = await setup();
    const now = new Date();
    await seed(ctx, now);

    const metrics = async (type, q = {}) => {
      const res = await ctx.get('metrics', { type, ...q });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe(type);
      return res.body.rows;
    };

    const path = await metrics('path');
    expect(path).toHaveLength(3);
    expect(path).toEqual(expect.arrayContaining([{ x: '/', y: 2 }, { x: '/about', y: 1 }, { x: '/products/hat', y: 1 }]));
    expect(path[0]).toEqual({ x: '/', y: 2 });

    expect(await metrics('fullPath')).toEqual(expect.arrayContaining([{ x: '/products/hat?utm_content=c1&utm_term=hats', y: 1 }]));
    // Same-origin "/" referrer is not a referrer.
    expect((await metrics('referrer')).sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: 'facebook.com', y: 1 }, { x: 'google.com', y: 1 }]);
    expect((await metrics('browser')).sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: 'chrome', y: 1 }, { x: 'firefox', y: 1 }, { x: 'ios', y: 1 }]);
    expect((await metrics('device')).sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: 'desktop', y: 1 }, { x: 'laptop', y: 1 }, { x: 'mobile', y: 1 }]);
    expect(await metrics('country')).toEqual([{ x: 'EG', y: 1 }]);
    expect(await metrics('language')).toEqual(expect.arrayContaining([{ x: 'en', y: 1 }, { x: 'ar', y: 1 }, { x: 'fr', y: 1 }]));
    expect(await metrics('event')).toEqual([{ x: 'add_to_cart', y: 1 }]);
    expect(await metrics('utm_content')).toEqual([{ x: 'c1', y: 1 }]);
    expect(await metrics('title')).toEqual(expect.arrayContaining([{ x: 'Home', y: 1 }, { x: 'Hat', y: 1 }]));
    expect((await metrics('channel')).sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: 'direct', y: 1 }, { x: 'organicSearch', y: 1 }, { x: 'organicSocial', y: 1 }]);
    expect((await metrics('entry')).sort((a, b) => b.y - a.y)).toEqual([{ x: '/', y: 2 }, { x: '/about', y: 1 }]);
    expect((await metrics('exit')).sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: '/', y: 1 }, { x: '/about', y: 1 }, { x: '/products/hat', y: 1 }]);
    expect(await metrics('path', { limit: 1 })).toHaveLength(1);
    expect(await metrics('path', { device: 'mobile' })).toEqual([{ x: '/', y: 1 }]);

    const bad = await ctx.get('metrics', { type: 'nope' });
    expect(bad.status).toBe(422);
  });

  it('weekly: 7x24 grid of distinct sessions', async () => {
    const ctx = await setup();
    const now = new Date();
    await seed(ctx, now);
    const res = await ctx.get('weekly', { tz: 'UTC' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(168);
    expect(res.body.rows[0]).toEqual({ dow: 0, hour: 0, visitors: expect.any(Number) });
    const total = res.body.rows.reduce((s, r) => s + r.visitors, 0);
    expect(total).toBeGreaterThanOrEqual(3);
    const cell = res.body.rows.find((r) => r.dow === new Date(now.getTime() - 3 * MIN).getUTCDay() && r.hour === new Date(now.getTime() - 3 * MIN).getUTCHours());
    expect(cell.visitors).toBeGreaterThanOrEqual(1);
  });

  it('realtime: last 30 minutes', async () => {
    const ctx = await setup();
    const now = new Date();
    await seed(ctx, now);
    const res = await ctx.get('realtime');
    expect(res.status).toBe(200);
    // B's 40-minute-old pageview is outside the window.
    expect(res.body.totals).toEqual({ views: 4, visitors: 3, events: 1, countries: 1 });
    expect(res.body.activeVisitors).toBe(2); // B (4 min) + C (3 min)
    expect(res.body.series.length).toBeGreaterThanOrEqual(30);
    expect(res.body.series.reduce((s, b) => s + b.pageviews, 0)).toBe(4);
    expect(res.body.activity).toHaveLength(5);
    expect(res.body.activity[0]).toMatchObject({ sessionId: 'session-cccc', type: 'pageview', urlPath: '/about', browser: 'firefox', country: 'EG' });
    expect(res.body.activity.map((a) => a.type).sort()).toEqual(['event', 'pageview', 'pageview', 'pageview', 'pageview']);
    expect(res.body.activity.find((a) => a.type === 'event').eventName).toBe('add_to_cart');
    expect(res.body.urls.sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: '/', y: 2 }, { x: '/about', y: 1 }, { x: '/products/hat', y: 1 }]);
    expect(res.body.referrers.sort((a, b) => a.x.localeCompare(b.x))).toEqual([{ x: 'facebook.com', y: 1 }, { x: 'google.com', y: 1 }]);
    expect(res.body.countries).toEqual([{ x: 'EG', y: 1 }]);
  });
});
