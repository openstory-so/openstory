import { describe, expect, it, vi } from 'vitest';
import {
  extractPromptForProvenance,
  extractStorageKey,
  formatReportReference,
  formatTraceId,
  parseTraceId,
  recordProvenance,
} from './provenance';
import { sha256Hex } from './hash';

describe('trace ids', () => {
  it('formats and parses a provenance id', () => {
    const id = '01JAV000000000000000000001';
    expect(formatTraceId(id)).toBe(`OS-${id}`);
    expect(parseTraceId(`os-${id.toLowerCase()}`)).toBe(id);
    expect(parseTraceId(id)).toBe(id);
  });

  it('uses a different prefix for report references', () => {
    const id = '01JAV000000000000000000002';
    expect(formatReportReference(id)).toBe(`OR-${id}`);
    expect(parseTraceId(`OR-${id}`)).toBeNull();
  });
});

describe('extractStorageKey', () => {
  it('uses r2KeyFromUrl for /r2/ paths', () => {
    expect(extractStorageKey('/r2/thumbnails/team/shot.png')).toBe(
      'thumbnails/team/shot.png'
    );
    expect(
      extractStorageKey('https://app.example.com/r2/videos/team/clip.mp4')
    ).toBe('videos/team/clip.mp4');
  });

  it('accepts a CDN URL or bare key that starts with a known bucket', () => {
    expect(
      extractStorageKey('https://storage.example.com/thumbnails/team/shot.png')
    ).toBe('thumbnails/team/shot.png');
    expect(extractStorageKey('videos/teams/abc/shot.mp4')).toBe(
      'videos/teams/abc/shot.mp4'
    );
  });

  it('does not treat a fal URL as a storage key', () => {
    expect(
      extractStorageKey('https://v3.fal.media/files/b/abc/out.png')
    ).toBeNull();
  });
});

describe('extractPromptForProvenance', () => {
  it('takes the first conventional non-empty key', () => {
    expect(extractPromptForProvenance({ prompt: '', text: 'hello' })).toBe(
      'hello'
    );
  });

  it('returns null rather than guessing', () => {
    expect(extractPromptForProvenance({ caption: 'nope' })).toBeNull();
  });
});

describe('recordProvenance', () => {
  it('returns OS-<id> and hashes the prompt', async () => {
    const record = vi
      .fn()
      .mockResolvedValue({ id: '01JAV000000000000000000003' });
    const trace = await recordProvenance(
      { record },
      {
        teamId: 'team_1',
        assetKind: 'frame_variant',
        assetId: 'asset_1',
        provider: 'fal',
        model: 'flux',
        prompt: 'a cat',
      }
    );
    expect(trace).toBe('OS-01JAV000000000000000000003');
    expect(record.mock.calls[0]?.[0].promptSha256).toBe(
      await sha256Hex('a cat')
    );
    expect(record.mock.calls[0]?.[0].prompt).toBeUndefined();
  });

  it('throws when the insert returns nothing', async () => {
    await expect(
      recordProvenance(
        { record: vi.fn().mockResolvedValue(undefined) },
        {
          teamId: 'team_1',
          assetKind: 'frame_variant',
          assetId: 'asset_1',
          provider: 'fal',
          model: 'flux',
        }
      )
    ).rejects.toThrow(/returned no id/);
  });

  it('throws when the recorder throws', async () => {
    await expect(
      recordProvenance(
        { record: vi.fn().mockRejectedValue(new Error('d1 down')) },
        {
          teamId: 'team_1',
          assetKind: 'frame_variant',
          assetId: 'asset_1',
          provider: 'fal',
          model: 'flux',
        }
      )
    ).rejects.toThrow('d1 down');
  });
});
