'use strict';

// The 6-digit codes' limits (otp/verificationCodeService). The per-IP ones
// come from the environment (VERIFICATION_CODES_PER_IP_PER_HOUR, _PER_DAY and
// VERIFICATION_SMS_PER_IP_PER_DAY), with defaults equal to the constants they
// replaced; the per-address and per-account ones stay fixed in the service.
//
// What production would read is checked by loading env.js in a child process
// started in an empty directory, as envSecrets.test.js does, so neither this
// suite's process.env nor a developer's .env can supply a value.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const env = require('../../src/config/env');
const codes = require('../../src/modules/otp/verificationCodeService');

const ENV_JS = path.resolve(__dirname, '../../src/config/env.js');
const NODE_NEEDS = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']);
const DB_PASSWORD = 'fixture-db-password';
const VARS = ['VERIFICATION_CODES_PER_IP_PER_HOUR', 'VERIFICATION_CODES_PER_IP_PER_DAY', 'VERIFICATION_SMS_PER_IP_PER_DAY'];

let emptyDir;

beforeAll(() => {
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zimos-code-limits-'));
});

afterAll(() => {
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

// dotenv may print its own line first, so the limits come on a marked line.
const MARK = 'LIMITS=';

function loadLimits(vars) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => NODE_NEEDS.has(key.toUpperCase())));
  const script = `const env = require(${JSON.stringify(ENV_JS)}); console.log(${JSON.stringify(MARK)} + JSON.stringify(env.verificationCodes))`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: emptyDir, env: { ...base, ...vars }, encoding: 'utf8' });
  const started = result.status === 0;
  const line = started ? result.stdout.split(/\r?\n/).find((l) => l.startsWith(MARK)) : null;
  return { started, limits: line ? JSON.parse(line.slice(MARK.length)) : null, stderr: result.stderr };
}

const production = (vars = {}) =>
  loadLimits({ NODE_ENV: 'production', JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'), DB_PASSWORD, ...vars });

const DEFAULTS = { ipPerHour: 20, ipPerDay: 50, smsPerIpPerDay: 5 };

it('the defaults are exactly the limits from before they came from the environment', () => {
  expect(codes.LIMITS).toEqual({
    targetPerHour: 5,
    targetPerDay: 10,
    ipPerHour: 20,
    ipPerDay: 50,
    smsPerIpPerDay: 5,
    smsPerAccountPerDay: 3,
  });
  expect(Object.isFrozen(codes.LIMITS)).toBe(true);
  expect(env.verificationCodes).toEqual(DEFAULTS);
  expect(codes.RESEND_COOLDOWN_MS).toBe(60 * 1000);
  expect(codes.MAX_ATTEMPTS).toBe(5);
  expect(codes.CODE_TTL_MS).toBe(10 * 60 * 1000);
});

it('production without the variables uses the same defaults', () => {
  expect(production()).toMatchObject({ started: true, limits: DEFAULTS });
});

it('a blank value counts as unset', () => {
  expect(production(Object.fromEntries(VARS.map((name) => [name, '  '])))).toMatchObject({ started: true, limits: DEFAULTS });
});

it('production takes each per-IP limit from its own variable', () => {
  const result = production({
    VERIFICATION_CODES_PER_IP_PER_HOUR: '200',
    VERIFICATION_CODES_PER_IP_PER_DAY: ' 1000 ',
    VERIFICATION_SMS_PER_IP_PER_DAY: '40',
  });
  expect(result).toMatchObject({ started: true, limits: { ipPerHour: 200, ipPerDay: 1000, smsPerIpPerDay: 40 } });
});

it.each(VARS.flatMap((name) => ['0', '-5', '20.5', 'abc', '1e3'].map((value) => [name, value])))(
  'refuses to start with %s=%p, naming the variable',
  (name, value) => {
    const { started, stderr } = production({ [name]: value });
    expect(started).toBe(false);
    expect(stderr).toContain(`${name} must be a whole number of 1 or more`);
  }
);

it('under NODE_ENV=test the defaults hold whatever the environment says', () => {
  const result = loadLimits({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    DB_PASSWORD,
    ...Object.fromEntries(VARS.map((name) => [name, '999'])),
  });
  expect(result).toMatchObject({ started: true, limits: DEFAULTS });
});
