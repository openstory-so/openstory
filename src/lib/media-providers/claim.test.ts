import { describe, expect, it } from 'vitest';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import { claimFrom, providerById } from './claim';

const teamKey: ResolvedApiKey = { key: 'team-key', source: 'team' };
const platformKey: ResolvedApiKey = { key: 'platform-key', source: 'platform' };

function provider(
  id: string,
  claim: (modelKey: string) => Promise<ResolvedApiKey | undefined>
) {
  return { id, claim };
}

describe('claimFrom', () => {
  it('returns the first provider that claims and does not ask later ones', async () => {
    const native = provider('xai', async (model) =>
      model === 'grok' ? teamKey : undefined
    );
    let falCalls = 0;
    const fal = provider('fal', async () => {
      falCalls += 1;
      return platformKey;
    });

    const claimed = await claimFrom([native, fal], 'grok');
    expect(claimed.provider.id).toBe('xai');
    expect(claimed.key).toEqual(teamKey);
    expect(falCalls).toBe(0);
  });

  it('falls through to a later always-claiming provider', async () => {
    const native = provider('xai', async () => undefined);
    const fal = provider('fal', async () => platformKey);

    const claimed = await claimFrom([native, fal], 'kling');
    expect(claimed.provider.id).toBe('fal');
    expect(claimed.key).toEqual(platformKey);
  });

  it('throws when nobody claims', async () => {
    const native = provider('xai', async () => undefined);
    await expect(claimFrom([native], 'kling')).rejects.toThrow(
      /No media provider claimed model "kling"/
    );
  });
});

describe('providerById', () => {
  const fal = provider('fal', async () => platformKey);

  it('finds a registered provider', () => {
    expect(providerById([fal], 'fal', 'motion').id).toBe('fal');
  });

  it('throws on an unknown id', () => {
    expect(() => providerById([fal], 'xai', 'motion')).toThrow(
      'Unknown motion provider: xai'
    );
  });
});
