'use strict';

/**
 * The test suite's own secrets, set before any test file loads
 * src/config/env.js (jest.config.js `setupFiles`). The code has no fallback
 * for them in any environment, so the suite brings these: values that say
 * what they are, kept here and only ever read by a process jest started.
 * They replace whatever a developer's .env holds, so a test never signs with
 * a real secret. env.js refuses any value starting with `test-only-` outside
 * NODE_ENV=test.
 *
 * DB_PASSWORD is not set here: it is the local test database's own password,
 * from .env.
 */

if (process.env.NODE_ENV !== 'test') {
  throw new Error('tests/helpers/testEnv.js sets test-only secrets and runs under NODE_ENV=test only');
}

process.env.JWT_ACCESS_SECRET = 'test-only-jwt-access-secret-never-used-outside-the-suite';
process.env.INTEGRATIONS_ENCRYPTION_KEY = 'test-only-integrations-key-never-used-outside-the-suite';
