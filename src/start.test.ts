import { describe, expect, it } from 'vitest';
// Static: a dynamic import of the start instance can blow the per-test timeout
// under full-suite load (same reason as src/lib/errors.test.ts).
import { startInstance } from '@/start';

const CSRF_SYMBOL = Symbol.for('tanstack-start:csrf-middleware');

describe('CSRF middleware wiring', () => {
  it('registers createCsrfMiddleware on requestMiddleware', async () => {
    // Custom src/start.ts disables Start's default CSRF install. Dropping
    // this from requestMiddleware is silent in production (dev-only warning).
    const options = await startInstance.getOptions();
    const requestMiddleware = options.requestMiddleware ?? [];

    expect(
      requestMiddleware.some((middleware) => CSRF_SYMBOL in middleware)
    ).toBe(true);
  });
});
