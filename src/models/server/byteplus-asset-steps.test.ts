import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';
import type { AssetPoolLedger } from './byteplus-asset-pool';

const mockConfig = vi.fn<() => unknown>(() => ({
  accessKey: 'AK',
  secretKey: 'SK',
}));
vi.doMock('./byteplus-config', () => ({
  bytePlusOpenApiConfig: mockConfig,
}));

const mockReserve = vi.fn(async () => 0);
vi.doMock('./byteplus-governor', () => ({
  reserveBytePlusCreateSlot: mockReserve,
}));

const mockClaim = vi.fn();
const mockCreate = vi.fn(async () => 'asset://created');
const mockEvict = vi.fn(async () => {});
vi.doMock('./byteplus-asset-pool', () => ({
  claimPooledAsset: mockClaim,
  createPooledAsset: mockCreate,
  evictPooledAsset: mockEvict,
}));

vi.doMock('./byteplus-asset-ingest', () => ({
  isHttpUrl: (url: string) => url.startsWith('http'),
  toArkFetchableUrl: async (url: string) => url,
}));

const mockAssertSize = vi.fn(async () => {});
vi.doMock('./byteplus-asset-size', () => ({
  assertArkCreateAssetSize: mockAssertSize,
}));

const { ingestArkAssets } = await import('./byteplus-asset-steps');

/**
 * Records step names in order (and each step's config); `do` runs inline,
 * `sleep` records its delay.
 */
function fakeStep() {
  const trace: string[] = [];
  const configs: Record<string, unknown> = {};
  const step = {
    do: async (
      name: string,
      configOrFn: unknown,
      maybeFn?: () => Promise<unknown>
    ) => {
      trace.push(name);
      if (maybeFn) configs[name] = configOrFn;
      const fn = maybeFn ?? configOrFn;
      if (typeof fn !== 'function') throw new Error('no step callback');
      return fn();
    },
    sleep: async (name: string, ms: number) => {
      trace.push(`${name}:${ms}`);
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only do/sleep are exercised
  return { step: step as unknown as WorkflowStep, trace, configs };
}

const ledger: AssetPoolLedger = {
  claimSlot: async () => ({ kind: 'exhausted' }),
  finalizeSlot: async () => true,
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only resolveOptionalKey is called
const credentials = {
  resolveOptionalKey: async () => undefined,
} as unknown as CredentialScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.mockReturnValue({ accessKey: 'AK', secretKey: 'SK' });
  mockAssertSize.mockResolvedValue(undefined);
});

describe('ingestArkAssets', () => {
  it('a pool hit needs no token and no wait', async () => {
    mockClaim.mockResolvedValue({ kind: 'hit', uri: 'asset://resident' });
    const { step, trace } = fakeStep();

    const map = await ingestArkAssets(step, {
      prefix: 'motion',
      stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
      ledger,
      owner: 'motion:run-1',
      credentials,
    });

    expect(map).toEqual({ 'https://cdn/a.png': 'asset://resident' });
    expect(trace).toEqual(['motion-ark-0-url', 'motion-ark-0-claim']);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockAssertSize).toHaveBeenCalledWith('https://cdn/a.png');
  });

  it('a miss reserves a turn, sleeps it durably, then creates', async () => {
    const claim = { kind: 'reserved', identity: 'h', evictedAssetId: null };
    mockClaim.mockResolvedValue(claim);
    mockReserve.mockResolvedValue(40_000);
    const { step, trace } = fakeStep();

    const map = await ingestArkAssets(step, {
      prefix: 'motion-retry-1',
      stills: [{ storedUrl: 'https://cdn/new.png', slot: 'frame' }],
      ledger,
      owner: 'motion:run-1',
      credentials,
    });

    expect(map).toEqual({ 'https://cdn/new.png': 'asset://created' });
    expect(trace).toEqual([
      'motion-retry-1-ark-0-url',
      'motion-retry-1-ark-0-claim',
      'motion-retry-1-ark-0-slot',
      'motion-retry-1-ark-0-wait:40000',
      'motion-retry-1-ark-0-create',
    ]);
    expect(mockClaim).toHaveBeenCalledWith(ledger, {
      identity: 'https://cdn/new.png',
      slot: 'frame',
      owner: 'motion:run-1',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      { accessKey: 'AK', secretKey: 'SK' },
      ledger,
      expect.objectContaining({
        claim,
        owner: 'motion:run-1',
        storedUrl: 'https://cdn/new.png',
        publicUrl: 'https://cdn/new.png',
        slot: 'frame',
      })
    );
    expect(mockAssertSize).toHaveBeenCalledWith('https://cdn/new.png');
  });

  it('deletes an evicted asset in its own step before waiting for a turn', async () => {
    mockClaim.mockResolvedValue({
      kind: 'reserved',
      identity: 'h',
      evictedAssetId: 'ark-old',
    });
    mockReserve.mockResolvedValue(0);
    const { step, trace } = fakeStep();

    await ingestArkAssets(step, {
      prefix: 'p',
      stills: [{ storedUrl: 'https://cdn/x.png', slot: 'frame' }],
      ledger,
      owner: 'motion:run-1',
      credentials,
    });

    // A failed delete retries this step and never reaches create; a retried
    // create never deletes twice.
    expect(trace).toEqual([
      'p-ark-0-url',
      'p-ark-0-claim',
      'p-ark-0-evict',
      'p-ark-0-slot',
      'p-ark-0-create',
    ]);
    expect(mockEvict).toHaveBeenCalledWith(
      { accessKey: 'AK', secretKey: 'SK' },
      { assetId: 'ark-old', slot: 'frame' }
    );
  });

  it('a failed evict never reaches create', async () => {
    mockClaim.mockResolvedValue({
      kind: 'reserved',
      identity: 'h',
      evictedAssetId: 'ark-old',
    });
    mockEvict.mockRejectedValue(new Error('DeleteAsset failed'));
    const { step } = fakeStep();

    await expect(
      ingestArkAssets(step, {
        prefix: 'p',
        stills: [{ storedUrl: 'https://cdn/x.png', slot: 'frame' }],
        ledger,
        owner: 'motion:run-1',
        credentials,
      })
    ).rejects.toThrow('DeleteAsset failed');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips the sleep when the token is free now, and registers a still once', async () => {
    mockClaim.mockResolvedValue({
      kind: 'reserved',
      identity: 'h',
      evictedAssetId: null,
    });
    mockReserve.mockResolvedValue(0);
    const { step, trace } = fakeStep();

    await ingestArkAssets(step, {
      prefix: 'p',
      stills: [
        { storedUrl: 'https://cdn/x.png', slot: 'library' },
        { storedUrl: 'https://cdn/x.png', slot: 'library' },
      ],
      ledger,
      owner: 'motion:run-1',
      credentials,
    });

    expect(trace).toEqual([
      'p-ark-0-url',
      'p-ark-0-claim',
      'p-ark-0-slot',
      'p-ark-0-create',
    ]);
  });

  it('without IAM keys sends the plain URL and touches neither pool nor governor', async () => {
    mockConfig.mockReturnValue(undefined);
    const { step, trace } = fakeStep();

    const map = await ingestArkAssets(step, {
      prefix: 'p',
      stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
      ledger,
      owner: 'motion:run-1',
      credentials,
    });

    expect(map).toEqual({ 'https://cdn/a.png': 'https://cdn/a.png' });
    expect(trace).toEqual(['p-ark-0-url', 'p-ark-0-claim']);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockAssertSize).toHaveBeenCalledWith('https://cdn/a.png');
  });

  it('a full pool fails the shot — nothing is degraded to a public URL', async () => {
    mockClaim.mockRejectedValue(new Error('every slot is leased'));
    const { step } = fakeStep();

    await expect(
      ingestArkAssets(step, {
        prefix: 'p',
        stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
        ledger,
        owner: 'motion:run-1',
        credentials,
      })
    ).rejects.toThrow('every slot is leased');
  });

  it('only the claim waits out another run — the url step keeps the default retries', async () => {
    mockClaim.mockResolvedValue({ kind: 'hit', uri: 'asset://resident' });
    const { step, configs } = fakeStep();

    await ingestArkAssets(step, {
      prefix: 'p',
      stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
      ledger,
      owner: 'motion:run-1',
      credentials,
    });

    // A bad fal key or a failed upload must not sit through minutes of
    // claim retries before the shot fails.
    expect(configs['p-ark-0-url']).toBeUndefined();
    expect(configs['p-ark-0-claim']).toEqual({
      retries: expect.objectContaining({ limit: 40, delay: '30 seconds' }),
    });
  });

  it('refuses a sub-300px still before claiming a CreateAsset turn (#1664)', async () => {
    mockAssertSize.mockRejectedValue(new Error('too small'));
    const { step } = fakeStep();

    await expect(
      ingestArkAssets(step, {
        prefix: 'p',
        stills: [{ storedUrl: 'https://cdn/tiny.png', slot: 'frame' }],
        ledger,
        owner: 'motion:run-1',
        credentials,
      })
    ).rejects.toThrow('too small');
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
