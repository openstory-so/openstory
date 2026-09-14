import { describe, expect, it, vi, beforeEach } from 'vitest';

const env: Record<string, string | undefined> = {};

vi.doMock('#env', () => ({ getEnv: () => env }));

const {
  aigcGroupName,
  aigcGroupScope,
  arkAdapterConfig,
  bytePlusAssetSlots,
  bytePlusOpenApiConfig,
  claimBytePlusVia,
  isBytePlusAssetsConfigured,
  isBytePlusConfigured,
  isPreviewPrAssetGroupName,
} = await import('./byteplus-config');

describe('claimBytePlusVia', () => {
  beforeEach(() => {
    env.ARK_API_KEY = undefined;
    env.ARK_BASE_URL = undefined;
    env.BYTEPLUS_ACCESS_KEY = undefined;
    env.BYTEPLUS_SECRET_KEY = undefined;
    env.BYTEPLUS_OPENAPI_HOST = undefined;
    env.BYTEPLUS_ASSET_GROUP_ID = undefined;
    env.BYTEPLUS_ASSET_SLOTS = undefined;
    env.E2E_TEST = undefined;
  });

  it('routes to fal when no Ark key is configured', () => {
    expect(
      claimBytePlusVia({
        native: true,
        usingOwnFalKey: false,
      })
    ).toBe('fal');
  });

  it('routes to byteplus when an Ark key is configured', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(
      claimBytePlusVia({
        native: true,
        usingOwnFalKey: false,
      })
    ).toBe('byteplus');
  });

  it('routes to fal for a model with no BytePlus id, key or not', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(claimBytePlusVia({ native: false, usingOwnFalKey: false })).toBe(
      'fal'
    );
  });

  // The BYOK rule is a billing invariant, not a preference: a team on its own
  // fal key is paying fal, so sending their work to our Ark account would move
  // the charge onto us silently.
  it('keeps a BYOK team on fal even when Ark is configured', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(
      claimBytePlusVia({
        native: true,
        usingOwnFalKey: true,
      })
    ).toBe('fal');
  });

  it('treats an empty-string key as unconfigured', () => {
    env.ARK_API_KEY = '';
    expect(isBytePlusConfigured()).toBe(false);
  });

  it('routes to fal when BYTEPLUS_ASSET_SLOTS is 0 even with an Ark key', () => {
    env.ARK_API_KEY = 'ark-test';
    env.BYTEPLUS_ASSET_SLOTS = '0';
    expect(
      claimBytePlusVia({
        native: true,
        usingOwnFalKey: false,
      })
    ).toBe('fal');
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

describe('isBytePlusAssetsConfigured', () => {
  beforeEach(() => {
    env.ARK_API_KEY = undefined;
    env.ARK_BASE_URL = undefined;
    env.BYTEPLUS_ACCESS_KEY = undefined;
    env.BYTEPLUS_SECRET_KEY = undefined;
    env.BYTEPLUS_OPENAPI_HOST = undefined;
    env.BYTEPLUS_ASSET_GROUP_ID = undefined;
    env.BYTEPLUS_ASSET_SLOTS = undefined;
    env.E2E_TEST = undefined;
  });

  it('is off without IAM keys', () => {
    env.ARK_API_KEY = 'ark-test';
    expect(isBytePlusAssetsConfigured()).toBe(false);
    expect(bytePlusOpenApiConfig()).toBeUndefined();
  });

  it('is on when both IAM keys are set', () => {
    env.BYTEPLUS_ACCESS_KEY = 'AKTEST';
    env.BYTEPLUS_SECRET_KEY = 'sk-test';
    env.BYTEPLUS_ASSET_GROUP_ID = 'group-1';
    expect(isBytePlusAssetsConfigured()).toBe(true);
    expect(bytePlusOpenApiConfig()).toMatchObject({
      accessKey: 'AKTEST',
      secretKey: 'sk-test',
      groupId: 'group-1',
    });
  });

  it('stays off under E2E_TEST unless a mock OpenAPI host is wired', () => {
    env.BYTEPLUS_ACCESS_KEY = 'AKTEST';
    env.BYTEPLUS_SECRET_KEY = 'sk-test';
    env.E2E_TEST = 'true';
    expect(isBytePlusAssetsConfigured()).toBe(false);
    env.BYTEPLUS_OPENAPI_HOST = 'http://localhost:4010';
    expect(isBytePlusAssetsConfigured()).toBe(true);
  });

  it('is off when BYTEPLUS_ASSET_SLOTS is 0 even with IAM keys', () => {
    env.BYTEPLUS_ACCESS_KEY = 'AKTEST';
    env.BYTEPLUS_SECRET_KEY = 'sk-test';
    env.BYTEPLUS_ASSET_SLOTS = '0';
    expect(bytePlusAssetSlots()).toBe(0);
    expect(isBytePlusAssetsConfigured()).toBe(false);
    expect(bytePlusOpenApiConfig()).toBeUndefined();
  });
});

describe('bytePlusAssetSlots', () => {
  beforeEach(() => {
    env.BYTEPLUS_ASSET_SLOTS = undefined;
  });

  it('defaults to 50 when unset', () => {
    expect(bytePlusAssetSlots()).toBe(50);
  });

  it('honours 0 so a process can stay off the shared pool', () => {
    env.BYTEPLUS_ASSET_SLOTS = '0';
    expect(bytePlusAssetSlots()).toBe(0);
  });

  it('honours a positive override', () => {
    env.BYTEPLUS_ASSET_SLOTS = '3';
    expect(bytePlusAssetSlots()).toBe(3);
  });
});

describe('aigcGroupName', () => {
  beforeEach(() => {
    env.VITE_APP_URL = undefined;
    env.VITE_IS_PREVIEW = undefined;
  });

  it('is per preview host so the D1 ledger stays 1 group ↔ 1 D1', () => {
    env.VITE_APP_URL = 'https://pr-1520.openstory.workers.dev';
    expect(aigcGroupScope()).toBe('preview');
    expect(aigcGroupName()).toBe(
      'openstory-virtual-pr-1520-openstory-workers-dev'
    );
  });

  it('treats VITE_IS_PREVIEW as preview without changing the host-derived name', () => {
    env.VITE_APP_URL = 'https://example.workers.dev';
    env.VITE_IS_PREVIEW = 'true';
    expect(aigcGroupScope()).toBe('preview');
    expect(aigcGroupName()).toBe('openstory-virtual-example-workers-dev');
  });

  it('keeps production per-host so the ledger sweep stays 1 group ↔ 1 D1', () => {
    env.VITE_APP_URL = 'https://openstory.so';
    expect(aigcGroupScope()).toBe('production');
    expect(aigcGroupName()).toBe('openstory-virtual-openstory-so');
  });

  it('keeps local per-host', () => {
    env.VITE_APP_URL = 'http://localhost:3000';
    expect(aigcGroupScope()).toBe('local');
    expect(aigcGroupName()).toBe('openstory-virtual-localhost-3000');
  });
});

describe('isPreviewPrAssetGroupName', () => {
  it('matches per-PR groups and not production or local names', () => {
    expect(
      isPreviewPrAssetGroupName(
        'openstory-virtual-pr-1520-openstory-workers-dev'
      )
    ).toBe(true);
    expect(
      isPreviewPrAssetGroupName(
        'openstory-virtual-pr-1520-openstory-workers-dev',
        1520
      )
    ).toBe(true);
    expect(
      isPreviewPrAssetGroupName(
        'openstory-virtual-pr-1520-openstory-workers-dev',
        152
      )
    ).toBe(false);
    expect(isPreviewPrAssetGroupName('openstory-virtual-preview')).toBe(false);
    expect(isPreviewPrAssetGroupName('openstory-virtual-openstory-so')).toBe(
      false
    );
  });
});

describe('arkAdapterConfig', () => {
  beforeEach(() => {
    env.ARK_BASE_URL = undefined;
  });

  it('omits baseURL so the adapter default applies', () => {
    const config = arkAdapterConfig('ark-test', 1000);
    expect(config.apiKey).toBe('ark-test');
    expect(config.timeout).toBe(1000);
    expect(config.baseURL).toBeUndefined();
    expect(config.fetch).toEqual(expect.any(Function));
  });

  it('passes ARK_BASE_URL through for e2e/proxy overrides', () => {
    env.ARK_BASE_URL = 'http://localhost:4010/ark';
    expect(arkAdapterConfig('ark-test', 1000).baseURL).toBe(
      'http://localhost:4010/ark'
    );
  });
});
