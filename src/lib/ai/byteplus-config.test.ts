import { describe, expect, it, vi, beforeEach } from 'vitest';

const env: Record<string, string | undefined> = {};

vi.doMock('#env', () => ({ getEnv: () => env }));

const { resolveMediaRoute, isBytePlusConfigured, arkAdapterConfig } =
  await import('./byteplus-config');

describe('resolveMediaRoute', () => {
  beforeEach(() => {
    env.ARK_API_KEY = undefined;
    env.ARK_BASE_URL = undefined;
  });

  it('routes to fal when no Ark key is configured', () => {
    expect(
      resolveMediaRoute({
        byteplusModelId: 'dreamina-seedance-2-0-260128',
        usingOwnFalKey: false,
      })
    ).toBe('fal');
  });

  it('routes to byteplus when an Ark key is configured', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(
      resolveMediaRoute({
        byteplusModelId: 'dreamina-seedance-2-0-260128',
        usingOwnFalKey: false,
      })
    ).toBe('byteplus');
  });

  it('routes to fal for a model with no BytePlus id, key or not', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(
      resolveMediaRoute({ byteplusModelId: undefined, usingOwnFalKey: false })
    ).toBe('fal');
  });

  // The BYOK rule is a billing invariant, not a preference: a team on its own
  // fal key is paying fal, so sending their work to our Ark account would move
  // the charge onto us silently.
  it('keeps a BYOK team on fal even when Ark is configured', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(
      resolveMediaRoute({
        byteplusModelId: 'dreamina-seedance-2-0-260128',
        usingOwnFalKey: true,
      })
    ).toBe('fal');
  });

  it('treats an empty-string key as unconfigured', () => {
    env.ARK_API_KEY = '';
    expect(isBytePlusConfigured()).toBe(false);
  });

  // Playwright injects the developer's process env into the worker, so a key
  // in a local .env.local would otherwise point the suite at real, billable
  // BytePlus — aimock cannot intercept Ark the way it intercepts fal.
  it('stays off under E2E_TEST when no mock host is wired', () => {
    env.ARK_API_KEY = 'ark-test';
    env.E2E_TEST = 'true';
    expect(isBytePlusConfigured()).toBe(false);
    env.E2E_TEST = undefined;
  });

  it('allows the route under E2E_TEST when ARK_BASE_URL points at a mock', () => {
    env.ARK_API_KEY = 'ark-test';
    env.E2E_TEST = 'true';
    env.ARK_BASE_URL = 'http://localhost:4010/ark';
    expect(isBytePlusConfigured()).toBe(true);
    env.E2E_TEST = undefined;
  });
});

describe('arkAdapterConfig', () => {
  beforeEach(() => {
    env.ARK_BASE_URL = undefined;
  });

  it('omits baseURL so the adapter default applies', () => {
    expect(arkAdapterConfig('ark-test', 1000)).toEqual({
      apiKey: 'ark-test',
      timeout: 1000,
    });
  });

  it('passes ARK_BASE_URL through for e2e/proxy overrides', () => {
    env.ARK_BASE_URL = 'http://localhost:4010/ark';
    expect(arkAdapterConfig('ark-test', 1000).baseURL).toBe(
      'http://localhost:4010/ark'
    );
  });
});
