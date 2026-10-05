'use strict';

// The client IP (core/middleware/clientIp.js): req.ip by default; with
// TRUST_EDGE_CLIENT_IP on, CF-Connecting-IP only on a request that carries
// Cloudflare's secret header with the right value and names one valid address.
// Everything that keys on or records the IP reads it through clientIp(req).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { app, request, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');
const { resolve, resolveClientIp, clientIp } = require('../../src/core/middleware/clientIp');

const SRC = path.resolve(__dirname, '../../src');
const ENV_JS = path.join(SRC, 'config/env.js');
const HEADER = 'x-zimos-edge';
const SECRET = 'a'.repeat(16) + crypto.randomBytes(16).toString('hex');
const ORIGINAL = { ...env.clientIp };

const PROXY_IP = '198.51.100.7'; // what req.ip reads from X-Forwarded-For
const VISITOR_IP = '203.0.113.10'; // what CF-Connecting-IP names

afterEach(() => {
  Object.assign(env.clientIp, ORIGINAL);
});

function edgeOn() {
  Object.assign(env.clientIp, { trustEdge: true, edgeHeader: HEADER, edgeSecret: SECRET });
}

// The ip may be given as undefined on purpose (a closed socket), so no default parameter.
const fakeReq = (headers = {}, ...ip) => ({ ip: ip.length ? ip[0] : PROXY_IP, headers: { ...headers } });

describe('resolve', () => {
  const combos = [
    {},
    { 'cf-connecting-ip': VISITOR_IP },
    { 'cf-connecting-ip': VISITOR_IP, [HEADER]: SECRET },
    { 'cf-connecting-ip': 'not-an-ip', [HEADER]: 'wrong' },
    { 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'x-real-ip': '3.3.3.3', 'cf-connecting-ip': VISITOR_IP, [HEADER]: SECRET },
  ];

  it('with the flag off is req.ip exactly, whatever the headers say, and leaves the headers alone', () => {
    Object.assign(env.clientIp, { edgeHeader: HEADER, edgeSecret: SECRET });
    for (const headers of combos) {
      for (const ip of [PROXY_IP, '::ffff:127.0.0.1', '2001:db8::1', undefined]) {
        const req = fakeReq(headers, ip);
        expect(resolve(req)).toEqual({ ip, source: 'proxy', reason: 'off' });
        const next = jest.fn();
        resolveClientIp(req, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.clientIp).toBe(ip);
        expect(clientIp(req)).toBe(ip);
        expect(req.headers).toEqual(headers);
      }
    }
  });

  it('ignores a CF-Connecting-IP sent without the secret header', () => {
    edgeOn();
    expect(resolve(fakeReq({ 'cf-connecting-ip': VISITOR_IP }))).toEqual({ ip: PROXY_IP, source: 'proxy', reason: 'secret_absent' });
    expect(resolve(fakeReq({ 'cf-connecting-ip': VISITOR_IP, [HEADER]: '' }))).toMatchObject({ ip: PROXY_IP, reason: 'secret_absent' });
  });

  it('ignores a wrong secret: another value, a prefix, a longer one, the header sent twice', () => {
    edgeOn();
    for (const wrong of ['nope', SECRET.slice(0, -1), `${SECRET}x`, `${SECRET}, ${SECRET}`, SECRET.toUpperCase()]) {
      expect(resolve(fakeReq({ 'cf-connecting-ip': VISITOR_IP, [HEADER]: wrong }))).toEqual({ ip: PROXY_IP, source: 'proxy', reason: 'secret_mismatch' });
    }
  });

  it('takes CF-Connecting-IP with the right secret and a valid address, IPv4 or IPv6', () => {
    edgeOn();
    for (const visitor of [VISITOR_IP, '2001:db8:85a3::8a2e:370:7334', ` ${VISITOR_IP} `]) {
      expect(resolve(fakeReq({ 'cf-connecting-ip': visitor, [HEADER]: SECRET }))).toEqual({ ip: visitor.trim(), source: 'edge', reason: 'edge' });
    }
  });

  it('ignores a CF-Connecting-IP that is missing or not one valid address', () => {
    edgeOn();
    expect(resolve(fakeReq({ [HEADER]: SECRET }))).toMatchObject({ ip: PROXY_IP, source: 'proxy', reason: 'cf_ip_absent' });
    for (const bad of ['', 'not-an-ip', '999.1.1.1', `${VISITOR_IP}, 192.0.2.1`, `${VISITOR_IP}:443`, '203.0.113.0/24', 'localhost']) {
      expect(resolve(fakeReq({ 'cf-connecting-ip': bad, [HEADER]: SECRET }))).toMatchObject({ ip: PROXY_IP, source: 'proxy', reason: 'cf_ip_invalid' });
    }
  });

  it('removes the secret header once checked, with the flag on', () => {
    edgeOn();
    const req = fakeReq({ 'cf-connecting-ip': VISITOR_IP, [HEADER]: SECRET });
    resolveClientIp(req, {}, () => {});
    expect(req.clientIp).toBe(VISITOR_IP);
    expect(req.headers[HEADER]).toBeUndefined();
    expect(req.headers['cf-connecting-ip']).toBe(VISITOR_IP);
  });

  it('reads a plain { ip } context as it is (the funnels pass one to order creation)', () => {
    expect(clientIp({ ip: VISITOR_IP })).toBe(VISITOR_IP);
    expect(clientIp(null)).toBeUndefined();
  });
});

describe('through the app: sessions, sign-up codes and the audit log', () => {
  /** Signs up with these headers; returns the IP each table recorded. */
  async function recordedIps(headers) {
    const email = uniqueEmail('client-ip');
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set({ 'X-Forwarded-For': `192.0.2.50, ${PROXY_IP}`, ...headers })
      .send({ phone: '01012345678', email, password: 'Passw0rd!123', fullName: 'Ip Probe' });
    expect(res.status).toBe(201);
    const userId = res.body.user.id;
    const session = await db.Session.findOne({ where: { userId } });
    const code = await db.VerificationCode.findOne({ where: { userId } });
    const store = await request(app)
      .post('/api/v1/workspaces')
      .set({ Authorization: `Bearer ${res.body.accessToken}`, 'X-Forwarded-For': `192.0.2.50, ${PROXY_IP}`, ...headers })
      .send({ name: 'Ip Store' });
    expect(store.status).toBe(201);
    const audit = await db.AuditLog.findOne({ where: { workspaceId: store.body.workspace.id, actorUserId: userId } });
    return { session: session.ipAddress, code: code ? code.requestIp : 'no code row', audit: audit ? audit.ipAddress : 'no audit row' };
  }
  const all = (ip) => ({ session: ip, code: ip, audit: ip });

  it('with the flag off records req.ip (the rightmost X-Forwarded-For entry), even with a forged CF-Connecting-IP and the right secret', async () => {
    Object.assign(env.clientIp, { edgeHeader: HEADER, edgeSecret: SECRET });
    expect(await recordedIps({})).toEqual(all(PROXY_IP));
    expect(await recordedIps({ 'CF-Connecting-IP': VISITOR_IP, [HEADER]: SECRET })).toEqual(all(PROXY_IP));
  });

  it('with the flag on: a forged header, a wrong secret or a bad address change nothing; the right secret does', async () => {
    edgeOn();
    expect(await recordedIps({ 'CF-Connecting-IP': VISITOR_IP })).toEqual(all(PROXY_IP));
    expect(await recordedIps({ 'CF-Connecting-IP': VISITOR_IP, [HEADER]: 'not-the-secret' })).toEqual(all(PROXY_IP));
    expect(await recordedIps({ 'CF-Connecting-IP': 'garbage', [HEADER]: SECRET })).toEqual(all(PROXY_IP));
    expect(await recordedIps({ 'CF-Connecting-IP': VISITOR_IP, [HEADER]: SECRET })).toEqual(all(VISITOR_IP));
  });
});

describe('CLIENT_IP_DEBUG', () => {
  it('logs the IP headers and req.ip, and never the secret, a cookie or a token', async () => {
    edgeOn();
    env.clientIp.debug = true;
    const spy = jest.spyOn(logger, 'info');
    try {
      await request(app)
        .get('/health?probe=ip-check')
        .set({
          'X-Forwarded-For': `192.0.2.50, ${PROXY_IP}`,
          'CF-Connecting-IP': VISITOR_IP,
          'X-Real-IP': '192.0.2.99',
          [HEADER]: SECRET,
          Cookie: 'refreshToken=cookie-value-123',
          Authorization: 'Bearer bearer-value-456',
        });
      const calls = spy.mock.calls.filter(([message]) => message === 'client ip');
      expect(calls).toHaveLength(1);
      const meta = calls[0][1];
      expect(meta).toMatchObject({
        url: '/health?probe=ip-check',
        headers: { 'x-forwarded-for': `192.0.2.50, ${PROXY_IP}`, 'cf-connecting-ip': VISITOR_IP, 'x-real-ip': '192.0.2.99' },
        reqIp: PROXY_IP,
        edgeSecret: 'match',
        trustEdge: true,
        clientIp: VISITOR_IP,
        source: 'edge',
      });
      const logged = JSON.stringify(meta);
      for (const secretValue of [SECRET, HEADER, 'cookie-value-123', 'bearer-value-456']) {
        expect(logged).not.toContain(secretValue);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('is silent while off', async () => {
    const spy = jest.spyOn(logger, 'info');
    try {
      await request(app).get('/health').set({ 'CF-Connecting-IP': VISITOR_IP });
      expect(spy.mock.calls.filter(([message]) => message === 'client ip')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('starting the app', () => {
  // As tests/integration/envSecrets.test.js: env.js in a child process, in an
  // empty directory, with only what node itself needs plus the case's vars.
  const NODE_NEEDS = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']);
  let emptyDir;
  beforeAll(() => {
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zimos-client-ip-'));
  });
  afterAll(() => {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
  function boot(vars) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => NODE_NEEDS.has(key.toUpperCase())));
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(ENV_JS)})`], {
      cwd: emptyDir,
      env: {
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
        DB_PASSWORD: 'fixture-db-password',
        ...vars,
      },
      encoding: 'utf8',
    });
    return { started: result.status === 0, stderr: result.stderr };
  }

  it('refuses a secret under 32 characters with the flag on, without printing it', () => {
    const short = 'short-edge-secret-31-chars-long';
    expect(short).toHaveLength(31);
    const res = boot({ TRUST_EDGE_CLIENT_IP: 'true', EDGE_SECRET_HEADER: HEADER, EDGE_SECRET: short });
    expect(res.started).toBe(false);
    expect(res.stderr).toContain('EDGE_SECRET must be at least 32 characters');
    expect(res.stderr).not.toContain(short);
  });

  it('refuses a missing or reserved header name with the flag on', () => {
    for (const name of ['', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'X Bad']) {
      const res = boot({ TRUST_EDGE_CLIENT_IP: 'true', EDGE_SECRET_HEADER: name, EDGE_SECRET: SECRET });
      expect([name, res.started]).toEqual([name, false]);
      expect(res.stderr).toContain('EDGE_SECRET_HEADER must name the header Cloudflare adds');
    }
  });

  it('starts with a valid header and a 32-character secret, and with the flag off whatever the secret', () => {
    expect(boot({ TRUST_EDGE_CLIENT_IP: 'true', EDGE_SECRET_HEADER: 'X-Zimos-Edge', EDGE_SECRET: 'b'.repeat(32) }).started).toBe(true);
    expect(boot({ TRUST_EDGE_CLIENT_IP: 'false', EDGE_SECRET_HEADER: '', EDGE_SECRET: 'short' }).started).toBe(true);
    expect(boot({}).started).toBe(true);
  });
});

describe('one source', () => {
  it('nothing in src reads req.ip but core/middleware/clientIp.js', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && full !== path.join(SRC, 'core/middleware/clientIp.js')) {
          // Comments may name req.ip; code may not.
          const code = fs
            .readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
          if (/\b(req|request)\.ips?\b|\.socket\.remoteAddress|\.connection\.remoteAddress/.test(code)) {
            offenders.push(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
