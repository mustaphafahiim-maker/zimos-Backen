'use strict';

// rateLimitStore.withSharedStore: counters stay in memory unless RATE_LIMIT_REDIS
// and REDIS_URL are both set and the Redis packages are installed.

// Runs `fn` with a fresh module registry: env set to `url`, the Redis packages present or not.
function withModules({ url = null, packages = true }, fn) {
  jest.isolateModules(() => {
    if (packages) {
      jest.doMock('ioredis', () => jest.fn().mockImplementation(() => ({ on: jest.fn(), status: 'ready', call: jest.fn() })), { virtual: true });
      jest.doMock('rate-limit-redis', () => ({ RedisStore: jest.fn().mockImplementation((opts) => ({ redis: true, opts })) }), { virtual: true });
    } else {
      jest.doMock('ioredis', () => {
        throw new Error("Cannot find module 'ioredis'");
      }, { virtual: true });
    }
    require('../../src/config/env').rateLimit.sharedStoreUrl = url;
    const logger = require('../../src/core/utils/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    fn({ ...require('../../src/core/middleware/rateLimitStore'), warn });
  });
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('rateLimitStore.withSharedStore', () => {
  it('off: every limiter is created as before, counting in memory', () => {
    withModules({}, ({ withSharedStore }) => {
      const made = withSharedStore((o) => o)({ windowMs: 60000, limit: 5 });
      expect(made).toEqual({ windowMs: 60000, limit: 5 });
    });
  });

  it('on with the packages: each limiter gets its own Redis store, and Redis down lets requests through', () => {
    withModules({ url: 'redis://cache.internal:6379' }, ({ withSharedStore }) => {
      const rateLimit = (o) => o;
      const a = withSharedStore(rateLimit)({ limit: 5 });
      const b = withSharedStore(rateLimit)({ limit: 9 });
      expect(a.store).toMatchObject({ redis: true, opts: { prefix: 'rl:1:' } });
      expect(b.store.opts.prefix).toBe('rl:2:');
      expect(a.passOnStoreError).toBe(true);
      // A limiter that brings its own store keeps it.
      expect(withSharedStore(rateLimit)({ store: 'own' }).store).toBe('own');
    });
  });

  it('on without the packages: memory, and a warning', () => {
    withModules({ url: 'redis://cache.internal:6379', packages: false }, ({ withSharedStore, warn }) => {
      const made = withSharedStore((o) => o)({ limit: 5 });
      expect(made.store).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/count in memory/));
    });
  });
});
