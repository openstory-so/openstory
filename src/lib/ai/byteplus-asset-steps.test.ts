import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
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
vi.doMock('./byteplus-asset-pool', () => ({
  claimPooledAsset: mockClaim,
  createPooledAsset: mockCreate,
}));

vi.doMock('./byteplus-asset-ingest', () => ({
  isHttpUrl: (url: string) => url.startsWith('http'),
  toArkFetchableUrl: async (url: string) => url,
}));

const { ingestArkAssets } = await import('./byteplus-asset-steps');

/** Records step names in order; `do` runs inline, `sleep` records its delay. */
function fakeStep() {
  const trace: string[] = [];
  const step = {
    do: async (name: string, fn: () => Promise<unknown>) => {
      trace.push(name);
      return fn();
    },
    sleep: async (name: string, ms: number) => {
      trace.push(`${name}:${ms}`);
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only do/sleep are exercised
  return { step: step as unknown as WorkflowStep, trace };
}

const ledger: AssetPoolLedger = {
  claimSlot: async () => ({ kind: 'exhausted' }),
  recordSlot: async () => {},
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only resolveOptionalKey is called
const credentials = {
  resolveOptionalKey: async () => undefined,
} as unknown as CredentialScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.mockReturnValue({ accessKey: 'AK', secretKey: 'SK' });
});

describe('ingestArkAssets', () => {
  it('a pool hit needs no token and no wait', async () => {
    mockClaim.mockResolvedValue({ kind: 'hit', uri: 'asset://resident' });
    const { step, trace } = fakeStep();

    const map = await ingestArkAssets(step, {
      prefix: 'motion',
      stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
      ledger,
      credentials,
    });

    expect(map).toEqual({ 'https://cdn/a.png': 'asset://resident' });
    expect(trace).toEqual(['motion-ark-0-claim']);
    expect(mockReserve).not.toHaveBeenCalled();
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
      credentials,
    });

    expect(map).toEqual({ 'https://cdn/new.png': 'asset://created' });
    expect(trace).toEqual([
      'motion-retry-1-ark-0-claim',
      'motion-retry-1-ark-0-slot',
      'motion-retry-1-ark-0-wait:40000',
      'motion-retry-1-ark-0-create',
    ]);
    expect(mockCreate).toHaveBeenCalledWith(
      { accessKey: 'AK', secretKey: 'SK', host: undefined },
      ledger,
      expect.objectContaining({
        claim,
        storedUrl: 'https://cdn/new.png',
        publicUrl: 'https://cdn/new.png',
        slot: 'frame',
      })
    );
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
      credentials,
    });

    expect(trace).toEqual(['p-ark-0-claim', 'p-ark-0-slot', 'p-ark-0-create']);
  });

  it('without IAM keys sends the plain URL and touches neither pool nor governor', async () => {
    mockConfig.mockReturnValue(undefined);
    const { step, trace } = fakeStep();

    const map = await ingestArkAssets(step, {
      prefix: 'p',
      stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
      ledger,
      credentials,
    });

    expect(map).toEqual({ 'https://cdn/a.png': 'https://cdn/a.png' });
    expect(trace).toEqual(['p-ark-0-claim']);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('a full pool fails the shot — nothing is degraded to a public URL', async () => {
    mockClaim.mockRejectedValue(new Error('every slot is leased'));
    const { step } = fakeStep();

    await expect(
      ingestArkAssets(step, {
        prefix: 'p',
        stills: [{ storedUrl: 'https://cdn/a.png', slot: 'library' }],
        ledger,
        credentials,
      })
    ).rejects.toThrow('every slot is leased');
  });
});
