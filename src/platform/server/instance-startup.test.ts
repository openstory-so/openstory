import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { holdInstanceStartup } from './instance-startup';

describe('holdInstanceStartup', () => {
  test('registers the startup promise before it settles', async () => {
    let release: () => void = () => {};
    const startup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: Promise<unknown>[] = [];
    holdInstanceStartup(
      { waitUntil: (promise) => held.push(promise) },
      startup
    );

    expect(held).toHaveLength(1);
    let settled = false;
    void held[0]?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await held[0];
  });

  test('keeps the context when startup rejects, without swallowing the error', async () => {
    const startup = Promise.reject(new Error('oauth_resource unread'));
    const held: Promise<unknown>[] = [];
    holdInstanceStartup(
      { waitUntil: (promise) => held.push(promise) },
      startup
    );

    await expect(held[0]).resolves.toBeUndefined();
    await expect(startup).rejects.toThrow('oauth_resource unread');
  });
});

describe('worker fetch wiring (#2073)', () => {
  test('the shared fetch handler holds seed and sign-in startup', () => {
    const source = readFileSync('src/server.ts', 'utf8');
    const fetchStart = source.indexOf('async fetch(request, env, ctx)');
    const scheduledStart = source.indexOf('scheduled(controller');
    const fetchBody = source.slice(fetchStart, scheduledStart);

    expect(fetchBody).toContain('async fetch(request, env, ctx)');
    const seedHold = fetchBody.indexOf('holdInstanceStartup(ctx, seeded)');
    const authHold = fetchBody.indexOf(
      'holdInstanceStartup(ctx, authStartupPromise())'
    );
    expect(seedHold).toBeGreaterThan(-1);
    expect(authHold).toBeGreaterThan(-1);
    expect(seedHold).toBeLessThan(fetchBody.indexOf('await seeded'));
    expect(authHold).toBeLessThan(fetchBody.indexOf('await handler.fetch'));
  });
});
