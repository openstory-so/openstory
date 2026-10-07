/**
 * BytePlus portrait-slot measurement for sheet reuse (#2017). The pool keys
 * an asset by the stored URL, so a series whose episodes each draw their own
 * sheets registers one `CreateAsset` per sheet per episode, while episodes
 * that point at the same sheet rows register each sheet once. Measured over
 * the registration path (`ingestArkAssets`: claim → governor turn → create),
 * with the pool and Ark stubbed; no call leaves the process.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';
import type { AssetPoolLedger } from './byteplus-asset-pool';
import type { ArkStill } from './byteplus-asset-steps';
import { asStub } from '@/test/as-stub';

vi.doMock('./byteplus-config', () => ({
  bytePlusOpenApiConfig: () => ({ accessKey: 'AK', secretKey: 'SK' }),
}));
const reserveTurn = vi.fn(async () => 0);
vi.doMock('./byteplus-governor', () => ({
  reserveBytePlusCreateSlot: reserveTurn,
}));
// The account's portrait library: one asset per stored URL, as in prod.
const resident = new Map<string, string>();
const createAsset = vi.fn(
  async (_config: unknown, _ledger: unknown, input: { storedUrl: string }) => {
    const uri = `asset://${resident.size + 1}`;
    resident.set(input.storedUrl, uri);
    return uri;
  }
);
vi.doMock('./byteplus-asset-pool', () => ({
  claimPooledAsset: async (
    _ledger: unknown,
    input: { identity: string; slot: string }
  ) => {
    const uri = resident.get(input.identity);
    return uri
      ? { kind: 'hit', uri }
      : { kind: 'reserved', identity: input.identity, evictedAssetId: null };
  },
  createPooledAsset: createAsset,
  evictPooledAsset: vi.fn(),
}));
vi.doMock('./byteplus-asset-ingest', () => ({
  isHttpUrl: (url: string) => url.startsWith('http'),
  toArkFetchableUrl: async (url: string) => url,
}));
vi.doMock('./byteplus-asset-size', () => ({
  assertArkCreateAssetSize: async () => undefined,
}));

const { ingestArkAssets } = await import('./byteplus-asset-steps');

// Steps run inline; the step name is unique per still and attempt.
const step = asStub<WorkflowStep>({
  do: async (_name: string, ...rest: unknown[]) => {
    const fn = rest.at(-1);
    if (typeof fn !== 'function') throw new Error('no step callback');
    return fn();
  },
  sleep: async () => undefined,
});
const ledger = asStub<AssetPoolLedger>({});
const credentials = asStub<CredentialScopedDb>({
  resolveOptionalKey: async () => undefined,
});

const EPISODES = 10;
const CAST = ['maya', 'ravi'] as const;
const LOOKS = ['default', 'gala'] as const;
const SHOTS_PER_EPISODE = 3;

/**
 * The person sheets a shot of `episode` sends, as `arkStillForMotionRef`
 * shapes them (`slot: 'library'`, a person, so never `plain`). Drawn: each
 * episode has its own sheet rows and URLs. Reused: every episode points at
 * episode 1's rows, so the URL is the same.
 */
function sheetStills(episode: number, reused: boolean): ArkStill[] {
  const owner = reused ? 1 : episode;
  return CAST.flatMap((character) =>
    LOOKS.map((look) => ({
      storedUrl: `https://cdn/r2/ep${owner}/${character}-${look}.png`,
      slot: 'library' as const,
    }))
  );
}

async function renderSeries(reused: boolean) {
  resident.clear();
  createAsset.mockClear();
  reserveTurn.mockClear();
  for (let episode = 1; episode <= EPISODES; episode++) {
    for (let shot = 1; shot <= SHOTS_PER_EPISODE; shot++) {
      await ingestArkAssets(step, {
        prefix: `ep${episode}-shot${shot}`,
        stills: sheetStills(episode, reused),
        ledger,
        owner: `motion:ep${episode}:shot${shot}`,
        credentials,
      });
    }
  }
  return {
    createAssetCalls: createAsset.mock.calls.length,
    governorTurns: reserveTurn.mock.calls.length,
    distinctUrls: resident.size,
  };
}

describe('sheet reuse and BytePlus portrait slots (#2017)', () => {
  beforeEach(() => {
    resident.clear();
  });

  it(`${EPISODES} episodes, ${CAST.length} characters × ${LOOKS.length} looks: drawn per episode registers ${EPISODES * CAST.length * LOOKS.length} assets, reused registers ${CAST.length * LOOKS.length}`, async () => {
    const drawn = await renderSeries(false);
    const reused = await renderSeries(true);
    // Every sheet is its own slot: one per look per episode. Already near
    // the ~45-slot production pool for a cast this small.
    expect(drawn).toEqual({
      createAssetCalls: 40,
      governorTurns: 40,
      distinctUrls: 40,
    });
    // Pointing at the same rows: one slot per look, however many episodes.
    expect(reused).toEqual({
      createAssetCalls: 4,
      governorTurns: 4,
      distinctUrls: 4,
    });
  });

  it('a second shot, or a second episode, of the same URL is a pool hit, not a registration', async () => {
    await renderSeries(true);
    const before = createAsset.mock.calls.length;
    await ingestArkAssets(step, {
      prefix: 'ep11-shot1',
      stills: sheetStills(11, true),
      ledger,
      owner: 'motion:ep11:shot1',
      credentials,
    });
    expect(createAsset.mock.calls.length).toBe(before);
  });
});
