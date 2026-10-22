import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ShotVariant } from '@/platform/server/db/schema';
import {
  EDITOR_FALLBACK_POLL_MS,
  sequenceVideoVariantsRefetchInterval,
} from './use-shots';

function variant(
  overrides: Partial<
    Pick<ShotVariant, 'variantType' | 'status' | 'discardedAt' | 'divergedAt'>
  >
): Pick<ShotVariant, 'variantType' | 'status' | 'discardedAt' | 'divergedAt'> {
  return {
    variantType: 'video',
    status: 'completed',
    discardedAt: null,
    divergedAt: null,
    ...overrides,
  };
}

describe('sequenceVideoVariantsRefetchInterval (#1381)', () => {
  it('is what ScenesView passes to the video-variants query', () => {
    const source = readFileSync(
      new URL('./scenes-view.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('sequenceVideoVariantsRefetchInterval({');
    expect(source).toContain('shotsGenerating: anyVideoGenerating');
    expect(source).toContain('discoverUntilMs');
    expect(source).toContain('refetchInterval: videoVariantsInterval');
  });

  it('polls while a primary shot is generating, before any variant row exists', () => {
    expect(
      sequenceVideoVariantsRefetchInterval({
        shotsGenerating: true,
        variants: undefined,
      })
    ).toBe(EDITOR_FALLBACK_POLL_MS);
  });

  it('polls an added model from a pending or generating video row while shots are idle', () => {
    for (const status of ['pending', 'generating'] as const) {
      expect(
        sequenceVideoVariantsRefetchInterval({
          shotsGenerating: false,
          variants: [variant({ status })],
        })
      ).toBe(EDITOR_FALLBACK_POLL_MS);
    }
  });

  it('stops when video rows are terminal, and ignores image or dismissed rows', () => {
    expect(
      sequenceVideoVariantsRefetchInterval({
        shotsGenerating: false,
        variants: [
          variant({ status: 'completed' }),
          variant({ status: 'failed' }),
          variant({ variantType: 'image', status: 'generating' }),
          variant({ status: 'generating', discardedAt: new Date() }),
          variant({ status: 'pending', divergedAt: new Date() }),
        ],
      })
    ).toBe(false);
  });

  it('keeps polling after add-model until the discovery window ends', () => {
    expect(
      sequenceVideoVariantsRefetchInterval({
        shotsGenerating: false,
        variants: [],
        discoverUntilMs: 10_000,
        nowMs: 9_999,
      })
    ).toBe(EDITOR_FALLBACK_POLL_MS);
    expect(
      sequenceVideoVariantsRefetchInterval({
        shotsGenerating: false,
        variants: [],
        discoverUntilMs: 10_000,
        nowMs: 10_000,
      })
    ).toBe(false);
  });
});
