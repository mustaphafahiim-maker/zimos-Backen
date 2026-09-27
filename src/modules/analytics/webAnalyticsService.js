'use strict';

const db = require('../../db/models');
const { ValidationError } = require('../../core/errors/AppError');

/**
 * Web analytics over analytics_events / analytics_sessions. The SQL is
 * ported from Umami (MIT) — getWebsiteStats, getPageviewStats,
 * getSessionStats, getPageviewMetrics, getSessionMetrics, getEventMetrics,
 * getChannelMetrics, getWeeklyTraffic, getRealtimeData — with Umami's
 * `website_id` scope replaced by `workspace_id` and every user value bound
 * through Sequelize replacements. Only pageviews (event_type = 1) count as
 * views; custom events are event_type 2.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const EVENT_TYPE = { pageView: 1, customEvent: 2 };

// Query-param filter -> SQL column. Session columns need the sessions join.
const EVENT_FILTERS = {
  url: 'e.url_path',
  referrer: 'e.referrer_domain',
  title: 'e.page_title',
  event: 'e.event_name',
  hostname: 'e.hostname',
  tag: 'e.tag',
  screen: 'e.screen',
  language: 'e.language',
  utm_source: 'e.source',
  utm_medium: 'e.medium',
  utm_campaign: 'e.campaign',
  utm_content: 'e.utm_content',
  utm_term: 'e.utm_term',
};
const SESSION_FILTERS = {
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  country: 's.country',
  region: 's.region',
  city: 's.city',
};
const FILTER_KEYS = [...Object.keys(EVENT_FILTERS), ...Object.keys(SESSION_FILTERS)];

// Metric type -> grouping expression.
const METRIC_COLUMNS = {
  path: 'e.url_path',
  entry: 'e.url_path',
  exit: 'e.url_path',
  title: 'e.page_title',
  query: 'e.url_query',
  referrer: 'e.referrer_domain',
  hostname: 'e.hostname',
  tag: 'e.tag',
  screen: 'e.screen',
  language: 'lower(left(e.language, 2))',
  utm_source: 'e.source',
  utm_medium: 'e.medium',
  utm_campaign: 'e.campaign',
  utm_content: 'e.utm_content',
  utm_term: 'e.utm_term',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  country: 's.country',
  region: 's.region',
  city: 's.city',
};
const FULL_PATH_SQL = "case when coalesce(e.url_query, '') <> '' then e.url_path || '?' || e.url_query else e.url_path end";
const SESSION_METRICS = new Set(['browser', 'os', 'device', 'country', 'region', 'city']);
const METRIC_TYPES = [...Object.keys(METRIC_COLUMNS), 'fullPath', 'channel', 'event'];

const UNITS = { minute: 'minute', hour: 'hour', day: 'day', month: 'month' };
const SESSION_JOIN = 'left join analytics_sessions s on s.id = e.session_id and s.workspace_id = e.workspace_id';

const toNumber = (v) => (v === null || v === undefined ? 0 : Number(v));
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Ported from Umami (MIT) date.ts#getMinimumUnit (date-range mode). */
function getMinimumUnit(from, to) {
  const minutes = (to - from) / 60000;
  if (minutes <= 60) return 'minute';
  if (minutes / 60 <= 48) return 'hour';
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (months <= 7) return 'day';
  return 'month';
}

async function workspaceTimeZone(workspaceId) {
  const ws = await db.Workspace.findByPk(workspaceId, { attributes: ['timezone'] });
  return (ws && ws.timezone && isValidTimeZone(ws.timezone) ? ws.timezone : null) || 'UTC';
}

/**
 * Normalises the common query params into { workspaceId, from, to, unit,
 * tz, compare, filters }. `to` is exclusive; ranges are clamped to 400 days.
 */
async function parseQuery(workspaceId, query = {}) {
  const to = query.to ? new Date(query.to) : new Date();
  let from = query.from ? new Date(query.from) : new Date(to.getTime() - DAY_MS);
  if (from >= to) throw new ValidationError([{ field: 'from', message: '"from" must be before "to"' }], 'Invalid query');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) from = new Date(to.getTime() - MAX_RANGE_DAYS * DAY_MS);

  const tz = query.tz || (await workspaceTimeZone(workspaceId));
  if (!isValidTimeZone(tz)) throw new ValidationError([{ field: 'tz', message: 'unknown IANA time zone' }], 'Invalid query');

  const filters = {};
  for (const key of FILTER_KEYS) {
    const values = asArray(query[key]).map(String).filter((v) => v !== '');
    if (values.length) filters[key] = values;
  }

  return {
    workspaceId,
    from,
    to,
    unit: UNITS[query.unit] || getMinimumUnit(from, to),
    tz,
    compare: query.compare || null,
    filters,
  };
}

/** The comparison window: `prev` shifts back by the range length, `yoy` by one year. */
function comparisonRange(ctx) {
  if (ctx.compare === 'yoy') {
    const shift = (d) => {
      const c = new Date(d);
      c.setUTCFullYear(c.getUTCFullYear() - 1);
      return c;
    };
    return { ...ctx, from: shift(ctx.from), to: shift(ctx.to), compare: null };
  }
  const len = ctx.to.getTime() - ctx.from.getTime();
  return { ...ctx, from: new Date(ctx.from.getTime() - len), to: new Date(ctx.to.getTime() - len), compare: null };
}

/**
 * Builds the shared WHERE fragment. `alias` is the events table alias;
 * every value is a named replacement, never interpolated.
 */
function buildFilters(ctx, { joinSession = false } = {}) {
  const replacements = { workspaceId: ctx.workspaceId, from: ctx.from, to: ctx.to, tz: ctx.tz };
  const clauses = [];
  let needsSession = joinSession;
  for (const [key, values] of Object.entries(ctx.filters)) {
    const column = EVENT_FILTERS[key] || SESSION_FILTERS[key];
    if (SESSION_FILTERS[key]) needsSession = true;
    replacements[`f_${key}`] = values;
    clauses.push(`and ${column} in (:f_${key})`);
  }
  return {
    replacements,
    filterQuery: clauses.join('\n'),
    joinQuery: needsSession ? SESSION_JOIN : '',
    dateQuery: 'and e.created_at >= :from and e.created_at < :to',
  };
}

async function raw(sql, replacements) {
  return db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
}

// ---------------------------------------------------------------------------
// Stats — ported from Umami getWebsiteStats (MIT)
// ---------------------------------------------------------------------------

async function queryStats(ctx) {
  const { replacements, filterQuery, joinQuery, dateQuery } = buildFilters(ctx);
  const [row] = await raw(
    `
    select
      cast(coalesce(sum(t.c), 0) as bigint) as "pageviews",
      count(distinct t.session_id) as "visitors",
      count(distinct t.visit_id) as "visits",
      coalesce(sum(case when t.c = 1 and coalesce(x.has_custom_event, 0) = 0 then 1 else 0 end), 0) as "bounces",
      cast(coalesce(sum(floor(extract(epoch from (t.max_time - t.min_time)))), 0) as bigint) as "totaltime"
    from (
      select
        e.session_id,
        e.visit_id,
        count(*) as "c",
        min(e.created_at) as "min_time",
        max(e.created_at) as "max_time"
      from analytics_events e
      ${joinQuery}
      where e.workspace_id = :workspaceId
        ${dateQuery}
        and e.event_type = ${EVENT_TYPE.pageView}
        ${filterQuery}
      group by 1, 2
    ) as t
    left join (
      select session_id, visit_id, 1 as "has_custom_event"
      from analytics_events e
      where e.workspace_id = :workspaceId
        ${dateQuery}
        and e.event_type = ${EVENT_TYPE.customEvent}
      group by 1, 2
    ) as x
      on x.session_id = t.session_id
      and x.visit_id = t.visit_id
    `,
    replacements
  );
  const pageviews = toNumber(row.pageviews);
  const visitors = toNumber(row.visitors);
  const visits = toNumber(row.visits);
  const bounces = toNumber(row.bounces);
  const totaltime = toNumber(row.totaltime);
  return {
    pageviews,
    visitors,
    visits,
    bounces,
    totaltime,
    // Null, not zero: "0% bounce rate" reads like a result, and there is none.
    bounceRate: visits > 0 ? Math.round((Math.min(visits, bounces) / visits) * 1000) / 10 : null,
    avgVisitTime: visits > 0 ? Math.round(totaltime / visits) : null,
  };
}

async function getStats(workspaceId, query) {
  const ctx = await parseQuery(workspaceId, query);
  const stats = await queryStats(ctx);
  if (ctx.compare) stats.comparison = await queryStats(comparisonRange(ctx));
  return stats;
}

// ---------------------------------------------------------------------------
// Series — ported from Umami getPageviewStats + getSessionStats (MIT),
// merged into one query and zero-filled with generate_series.
// ---------------------------------------------------------------------------

async function querySeries(ctx) {
  const { replacements, filterQuery, joinQuery, dateQuery } = buildFilters(ctx);
  const unit = UNITS[ctx.unit];
  const rows = await raw(
    `
    with buckets as (
      select generate_series(
        date_trunc('${unit}', (:from)::timestamptz at time zone :tz),
        date_trunc('${unit}', ((:to)::timestamptz - interval '1 millisecond') at time zone :tz),
        interval '1 ${unit}'
      ) as b
    ),
    counts as (
      select
        date_trunc('${unit}', e.created_at at time zone :tz) as b,
        count(*) as pageviews,
        count(distinct e.session_id) as visitors
      from analytics_events e
      ${joinQuery}
      where e.workspace_id = :workspaceId
        ${dateQuery}
        and e.event_type = ${EVENT_TYPE.pageView}
        ${filterQuery}
      group by 1
    )
    select
      (buckets.b at time zone :tz) as t,
      coalesce(counts.pageviews, 0) as pageviews,
      coalesce(counts.visitors, 0) as visitors
    from buckets
    left join counts on counts.b = buckets.b
    order by buckets.b
    `,
    replacements
  );
  return rows.map((r) => ({ t: new Date(r.t).toISOString(), pageviews: toNumber(r.pageviews), visitors: toNumber(r.visitors) }));
}

async function getSeries(workspaceId, query) {
  const ctx = await parseQuery(workspaceId, query);
  const result = { unit: ctx.unit, series: await querySeries(ctx) };
  if (ctx.compare) result.comparison = await querySeries(comparisonRange(ctx));
  return result;
}

// ---------------------------------------------------------------------------
// Metrics — ported from Umami getPageviewMetrics / getSessionMetrics /
// getEventMetrics / getChannelMetrics (MIT)
// ---------------------------------------------------------------------------

// Domain lists from Umami constants.ts (MIT).
const SOCIAL_DOMAINS = ['bsky.app', 'facebook.com', 'fb.com', 'ig.com', 'instagram.com', 'linkedin.', 'news.ycombinator.com', 'pinterest.', 'reddit.', 'snapchat.', 't.co', 'threads.net', 'tiktok.', 'twitter.com', 'x.com'];
const SEARCH_DOMAINS = ['baidu.com', 'bing.com', 'duckduckgo.com', 'ecosia.org', 'google.', 'msn.com', 'search.brave.com', 'yandex.'];
const LLM_DOMAINS = ['chatgpt.com', 'claude.ai', 'copilot.microsoft.com', 'gemini.google.com', 'meta.ai', 'perplexity.ai'];
const SHOPPING_DOMAINS = ['alibaba.com', 'aliexpress.com', 'amazon.', 'bestbuy.com', 'ebay.com', 'etsy.com', 'newegg.com', 'target.com', 'walmart.com'];
const EMAIL_DOMAINS = ['gmail.', 'hotmail.', 'mail.yahoo.', 'outlook.', 'proton.me', 'protonmail.'];
const VIDEO_DOMAINS = ['twitch.', 'youtube.'];
const PAID_AD_PARAMS = ['ad_id=', 'aid=', 'dclid=', 'epik=', 'gclid=', 'li_fat_id=', 'msclkid=', 'ob_click_id=', 'pc_id=', 'rdt_cid=', 'scid=', 'ttclid=', 'twclid=', 'utm_medium=cpc', 'utm_medium=paid'];

/** Constant (non-user) lists rendered as `col ilike '%x%' OR ...`, LIKE-escaped like Umami. */
function likeAny(column, list) {
  const esc = (v) => v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/'/g, "''");
  return list.map((v) => `${column} ilike '%${esc(v)}%'`).join(' or ');
}

async function queryChannelMetrics(ctx, limit) {
  const { replacements, filterQuery, joinQuery, dateQuery } = buildFilters(ctx);
  const rows = await raw(
    `
    with prefix as (
      select
        case when e.medium like 'p%' or e.medium like '%ppc%' or e.medium like '%retargeting%' or e.medium like '%paid%'
          then 'paid' else 'organic' end as prefix,
        coalesce(e.referrer_domain, '') as referrer_domain,
        coalesce(e.url_query, '') as url_query,
        coalesce(e.medium, '') as utm_medium,
        coalesce(e.source, '') as utm_source,
        coalesce(e.hostname, '') as hostname,
        e.session_id,
        e.visit_id,
        e.id as event_id,
        e.created_at
      from analytics_events e
      ${joinQuery}
      where e.workspace_id = :workspaceId
        ${dateQuery}
        and e.event_type = ${EVENT_TYPE.pageView}
        ${filterQuery}
    ),
    channels as (
      select case
          when referrer_domain = '' and url_query = '' then 'direct'
          when ${likeAny('url_query', PAID_AD_PARAMS)} then 'paidAds'
          when ${likeAny('utm_medium', ['referral', 'app', 'link'])} then 'referral'
          when utm_medium ilike '%affiliate%' then 'affiliate'
          when utm_medium ilike '%sms%' or utm_source ilike '%sms%' then 'sms'
          when ${likeAny('referrer_domain', LLM_DOMAINS)} then 'llm'
          when ${likeAny('referrer_domain', SEARCH_DOMAINS)} or utm_medium ilike '%organic%' then concat(prefix, 'Search')
          when ${likeAny('referrer_domain', SOCIAL_DOMAINS)} then concat(prefix, 'Social')
          when ${likeAny('referrer_domain', EMAIL_DOMAINS)} or utm_medium ilike '%mail%' then 'email'
          when ${likeAny('referrer_domain', SHOPPING_DOMAINS)} or utm_medium ilike '%shop%' then concat(prefix, 'Shopping')
          when ${likeAny('referrer_domain', VIDEO_DOMAINS)} or utm_medium ilike '%video%' then concat(prefix, 'Video')
          when referrer_domain <> regexp_replace(hostname, '^www.', '') and referrer_domain <> '' then 'referral'
          else '' end as x,
        session_id, visit_id, event_id, created_at
      from prefix
    ),
    visit_channels as (
      select session_id, visit_id, coalesce(nullif(x, ''), 'direct') as x
      from (
        select x, session_id, visit_id,
          row_number() over (
            partition by session_id, visit_id
            order by case when x <> '' then 0 else 1 end, created_at, event_id
          ) as row_num
        from channels
      ) as ranked
      where row_num = 1
    )
    select x, count(distinct session_id) as y
    from visit_channels
    group by x
    order by y desc
    limit :limit
    `,
    { ...replacements, limit }
  );
  return rows.map((r) => ({ x: r.x, y: toNumber(r.y) }));
}

async function queryEventMetrics(ctx, limit) {
  const { replacements, filterQuery, joinQuery, dateQuery } = buildFilters(ctx);
  const rows = await raw(
    `
    select e.event_name as x, count(*) as y
    from analytics_events e
    ${joinQuery}
    where e.workspace_id = :workspaceId
      ${dateQuery}
      and e.event_type = ${EVENT_TYPE.customEvent}
      ${filterQuery}
    group by 1
    order by 2 desc
    limit :limit
    `,
    { ...replacements, limit }
  );
  return rows.map((r) => ({ x: r.x, y: toNumber(r.y) }));
}

async function queryPageMetrics(ctx, type, limit) {
  const { replacements, filterQuery, joinQuery, dateQuery } = buildFilters(ctx, { joinSession: SESSION_METRICS.has(type) });
  let column = type === 'fullPath' ? 'e.url_path' : METRIC_COLUMNS[type];
  let selectColumn = type === 'fullPath' ? FULL_PATH_SQL : column;
  let entryExitQuery = '';
  let excludeDomain = '';

  if (type === 'referrer') {
    // Own hostnames are never a referrer.
    excludeDomain = "and (e.hostname is null or e.referrer_domain <> regexp_replace(e.hostname, '^www.', ''))";
  }
  if (type === 'entry' || type === 'exit') {
    const order = type === 'entry' ? 'asc' : 'desc';
    entryExitQuery = `
      join (
        select distinct on (visit_id) visit_id, url_path
        from analytics_events
        where workspace_id = :workspaceId
          and created_at >= :from and created_at < :to
          and event_type = ${EVENT_TYPE.pageView}
        order by visit_id, created_at ${order}
      ) x on x.visit_id = e.visit_id
    `;
    column = 'x.url_path';
    selectColumn = column;
  }

  const rows = await raw(
    `
    select ${selectColumn} as x, count(distinct e.session_id) as y
    from analytics_events e
    ${joinQuery}
    ${entryExitQuery}
    where e.workspace_id = :workspaceId
      ${dateQuery}
      and e.event_type = ${EVENT_TYPE.pageView}
      and ${column} is not null and ${column} <> ''
      ${excludeDomain}
      ${filterQuery}
    group by 1
    order by 2 desc
    limit :limit
    `,
    { ...replacements, limit }
  );
  return rows.map((r) => ({ x: r.x, y: toNumber(r.y) }));
}

async function getMetrics(workspaceId, query) {
  const ctx = await parseQuery(workspaceId, query);
  const type = query.type;
  const limit = Math.min(Number(query.limit) || 100, 500);
  let rows;
  if (type === 'channel') rows = await queryChannelMetrics(ctx, limit);
  else if (type === 'event') rows = await queryEventMetrics(ctx, limit);
  else rows = await queryPageMetrics(ctx, type, limit);
  return { type, rows };
}

// ---------------------------------------------------------------------------
// Weekly traffic — ported from Umami getWeeklyTraffic (MIT)
// ---------------------------------------------------------------------------

async function getWeekly(workspaceId, query) {
  const ctx = await parseQuery(workspaceId, query);
  const { replacements, filterQuery, joinQuery, dateQuery } = buildFilters(ctx);
  const rows = await raw(
    `
    select
      extract(dow from (e.created_at at time zone :tz))::int as dow,
      extract(hour from (e.created_at at time zone :tz))::int as hour,
      count(distinct e.session_id) as visitors
    from analytics_events e
    ${joinQuery}
    where e.workspace_id = :workspaceId
      ${dateQuery}
      and e.event_type = ${EVENT_TYPE.pageView}
      ${filterQuery}
    group by 1, 2
    `,
    replacements
  );
  const lookup = new Map(rows.map((r) => [`${r.dow}:${r.hour}`, toNumber(r.visitors)]));
  const out = [];
  for (let dow = 0; dow < 7; dow += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      out.push({ dow, hour, visitors: lookup.get(`${dow}:${hour}`) || 0 });
    }
  }
  return { rows: out };
}

// ---------------------------------------------------------------------------
// Realtime — ported from Umami getRealtimeData / getRealtimeActivity /
// getActiveVisitors (MIT)
// ---------------------------------------------------------------------------

async function getRealtime(workspaceId, query = {}) {
  const now = new Date();
  const ctx = await parseQuery(workspaceId, {
    ...query,
    from: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
    to: new Date(now.getTime() + 60 * 1000).toISOString(), // events stamped a few seconds ahead still show
    unit: 'minute',
    compare: undefined,
  });
  const { replacements, filterQuery, dateQuery } = buildFilters(ctx);

  const [series, activity, [totals], [active]] = await Promise.all([
    querySeries(ctx),
    raw(
      `
      select
        e.session_id as "sessionId",
        e.visit_id as "visitId",
        e.event_type as "eventType",
        e.event_name as "eventName",
        e.url_path as "urlPath",
        e.referrer_domain as "referrerDomain",
        s.browser, s.os, s.device, s.country,
        e.created_at as "createdAt"
      from analytics_events e
      ${SESSION_JOIN}
      where e.workspace_id = :workspaceId
        ${dateQuery}
        ${filterQuery}
      order by e.created_at desc
      limit 100
      `,
      replacements
    ),
    raw(
      `
      select
        count(*) filter (where e.event_type = ${EVENT_TYPE.pageView}) as views,
        count(distinct e.session_id) as visitors,
        count(*) filter (where e.event_type = ${EVENT_TYPE.customEvent}) as events,
        count(distinct s.country) as countries
      from analytics_events e
      ${SESSION_JOIN}
      where e.workspace_id = :workspaceId
        ${dateQuery}
        ${filterQuery}
      `,
      replacements
    ),
    raw(
      `
      select count(distinct e.session_id) as visitors
      from analytics_events e
      where e.workspace_id = :workspaceId and e.created_at >= :activeFrom
      `,
      { workspaceId, activeFrom: new Date(now.getTime() - 5 * 60 * 1000) }
    ),
  ]);

  const increment = (map, key) => {
    if (key) map.set(key, (map.get(key) || 0) + 1);
  };
  const urls = new Map();
  const referrers = new Map();
  const countries = new Map();
  const seen = new Set();
  for (const a of activity) {
    if (a.eventType === EVENT_TYPE.pageView) {
      increment(urls, a.urlPath);
      increment(referrers, a.referrerDomain);
    }
    if (!seen.has(a.sessionId)) {
      seen.add(a.sessionId);
      increment(countries, a.country);
    }
  }
  const toRows = (map) => [...map.entries()].map(([x, y]) => ({ x, y })).sort((p, q) => q.y - p.y);

  return {
    totals: {
      views: toNumber(totals.views),
      visitors: toNumber(totals.visitors),
      events: toNumber(totals.events),
      countries: toNumber(totals.countries),
    },
    series,
    activity: activity.map((a) => ({
      sessionId: a.sessionId,
      visitId: a.visitId,
      type: a.eventType === EVENT_TYPE.pageView ? 'pageview' : 'event',
      eventName: a.eventName,
      urlPath: a.urlPath,
      referrerDomain: a.referrerDomain,
      browser: a.browser,
      os: a.os,
      device: a.device,
      country: a.country,
      createdAt: new Date(a.createdAt).toISOString(),
    })),
    urls: toRows(urls),
    referrers: toRows(referrers),
    countries: toRows(countries),
    activeVisitors: toNumber(active.visitors),
    timestamp: now.toISOString(),
  };
}

module.exports = {
  FILTER_KEYS,
  METRIC_TYPES,
  getMinimumUnit,
  parseQuery,
  getStats,
  getSeries,
  getMetrics,
  getWeekly,
  getRealtime,
};
