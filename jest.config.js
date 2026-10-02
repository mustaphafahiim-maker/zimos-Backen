'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Test-only secrets, set before anything loads src/config/env.js.
  setupFiles: ['<rootDir>/tests/helpers/testEnv.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/setup.js'],
  testTimeout: 20000,
  verbose: true,
};
