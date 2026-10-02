'use strict';

// src/config/env.js holds no fallback for a secret. It refuses to start
// without JWT_ACCESS_SECRET or a database password in every environment,
// refuses a JWT_ACCESS_SECRET shorter than 32 characters in production, and
// refuses the suite's test-only value outside NODE_ENV=test — naming the
// variable, never printing its value.
//
// Each case loads env.js in a child process started in an empty directory
// with only what node itself needs in its environment, so neither this
// suite's process.env nor a developer's .env can supply what a case leaves out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENV_JS = path.resolve(__dirname, '../../src/config/env.js');
const NODE_NEEDS = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']);

let emptyDir;

beforeAll(() => {
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zimos-env-'));
});

afterAll(() => {
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

function loadEnv(vars) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => NODE_NEEDS.has(key.toUpperCase())));
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(ENV_JS)})`], {
    cwd: emptyDir,
    env: { ...base, ...vars },
    encoding: 'utf8',
  });
  return { started: result.status === 0, stderr: result.stderr };
}

const realSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const DB_PASSWORD = 'fixture-db-password';

it('the suite runs on its own test-only secret, never one from .env', () => {
  expect(process.env.JWT_ACCESS_SECRET.startsWith('test-only-')).toBe(true);
  expect(require('../../src/config/env').jwt.accessSecret).toBe(process.env.JWT_ACCESS_SECRET);
});

describe('production', () => {
  const prod = (vars) => loadEnv({ NODE_ENV: 'production', ...vars });

  it('starts with a 32-character JWT_ACCESS_SECRET and a database password (JWT_REFRESH_SECRET is not read)', () => {
    expect(prod({ JWT_ACCESS_SECRET: realSecret(16), DB_PASSWORD })).toMatchObject({ started: true });
  });

  it('refuses to start without JWT_ACCESS_SECRET, naming it', () => {
    const { started, stderr } = prod({ DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is not set: set it in the environment/);
  });

  it('treats a blank JWT_ACCESS_SECRET as missing', () => {
    const { started, stderr } = prod({ JWT_ACCESS_SECRET: '   ', DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is not set/);
  });

  it('refuses a JWT_ACCESS_SECRET shorter than 32 characters without printing it', () => {
    const short = realSecret(16).slice(0, 31);
    const { started, stderr } = prod({ JWT_ACCESS_SECRET: short, DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is shorter than 32 characters/);
    expect(stderr).not.toContain(short);
  });

  it("refuses the test suite's own secret without printing it", () => {
    const { started, stderr } = prod({ JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET, DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET holds the test suite's value/);
    expect(stderr).not.toContain(process.env.JWT_ACCESS_SECRET);
  });

  it('refuses to start without a database password, naming DB_PASSWORD', () => {
    const { started, stderr } = prod({ JWT_ACCESS_SECRET: realSecret() });
    expect(started).toBe(false);
    expect(stderr).toMatch(/DB_PASSWORD is not set: set it in the environment, or give DATABASE_URL a password/);
  });

  it('takes the database password from DATABASE_URL', () => {
    const result = prod({
      JWT_ACCESS_SECRET: realSecret(),
      DATABASE_URL: `postgres://zimos:${DB_PASSWORD}@db.example.com:5432/zimos`,
    });
    expect(result).toMatchObject({ started: true });
  });

  it('names every missing secret at once', () => {
    const { started, stderr } = prod({});
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is not set/);
    expect(stderr).toMatch(/DB_PASSWORD is not set/);
  });
});

describe('development', () => {
  it('refuses to start without JWT_ACCESS_SECRET and points at .env', () => {
    const { started, stderr } = loadEnv({ NODE_ENV: 'development', DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is not set: set it in \.env \(see \.env\.example\)/);
  });

  it('refuses the same way when NODE_ENV is unset', () => {
    const { started, stderr } = loadEnv({ DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/Refusing to start \(NODE_ENV=development\)/);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is not set/);
  });

  it('refuses to start without DB_PASSWORD', () => {
    const { started, stderr } = loadEnv({ NODE_ENV: 'development', JWT_ACCESS_SECRET: realSecret() });
    expect(started).toBe(false);
    expect(stderr).toMatch(/DB_PASSWORD is not set: set it in \.env/);
  });

  it("refuses the test suite's own secret", () => {
    const { started, stderr } = loadEnv({ NODE_ENV: 'development', JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET, DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET holds the test suite's value/);
  });

  it('starts with both set', () => {
    expect(loadEnv({ NODE_ENV: 'development', JWT_ACCESS_SECRET: realSecret(), DB_PASSWORD })).toMatchObject({ started: true });
  });
});

describe('test', () => {
  it('has no fallback either: without the suite setting it, JWT_ACCESS_SECRET is missing', () => {
    const { started, stderr } = loadEnv({ NODE_ENV: 'test', DB_PASSWORD });
    expect(started).toBe(false);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET is not set: under NODE_ENV=test it comes from tests\/helpers\/testEnv\.js/);
  });
});
