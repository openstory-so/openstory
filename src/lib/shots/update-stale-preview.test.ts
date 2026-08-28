import { describe, expect, it, vi } from 'vitest';
import { micros } from '@/lib/billing/money';

const { estimateImageCost, estimateVideoCost, estimateAudioCost } = vi.hoisted(
  () => ({
    estimateImageCost: vi.fn(),
    estimateVideoCost: vi.fn(),
    estimateAudioCost: vi.fn(),
  })
);
vi.mock('@/lib/billing/cost-estimation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  estimateImageCost,
  estimateVideoCost,
  estimateAudioCost,
}));

const { buildUpdateStalePreview } = await import('./update-stale-preview');

const target = (o: object) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  ({
    shotId: 's1',
    regenVisual: false,
    regenMotion: false,
    regenImage: false,
    regenVideo: false,
    durationMs: 4000,
    imageModel: 'seedream_v5',
    ...o,
  }) as never;

const plan = (targets: unknown[], music: unknown = null) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  ({
    aspectRatio: '16:9',
    sequence: { videoModel: 'seedance_v2' },
    targets,
    music,
    skipped: [],
    promptContext: null,
  }) as never;

describe('buildUpdateStalePreview', () => {
  it('buckets targets per level and accumulates cost by depth', () => {
    estimateImageCost.mockReturnValue(micros(40_000)); // $0.04
    estimateVideoCost.mockReturnValue(micros(500_000)); // $0.50
    const preview = buildUpdateStalePreview(
      plan([
        target({ shotId: 'a', regenVisual: true, regenImage: true }),
        target({ shotId: 'b', regenMotion: true, regenVideo: true }),
      ]),
      {},
      null
    );
    expect(preview.visualPromptShotIds).toEqual(['a']);
    expect(preview.motionPromptShotIds).toEqual(['b']);
    expect(preview.imageShotIds).toEqual(['a']);
    expect(preview.videoShotIds).toEqual(['b']);
    // 2 LLM calls at $0.02; image $0.04; video $0.50; no music
    expect(preview.costByLevel).toEqual({
      prompts: 40_000,
      images: 40_000,
      video: 500_000,
      music: 0,
    });
  });

  it('unknown pricing yields null, never an invented number', () => {
    estimateImageCost.mockReturnValue(null);
    const preview = buildUpdateStalePreview(
      plan([target({ shotId: 'a', regenImage: true })]),
      {},
      null
    );
    expect(preview.costByLevel.prompts).toBe(0);
    expect(preview.costByLevel.images).toBeNull();
  });

  it('prices music prompt and track', () => {
    estimateAudioCost.mockReturnValue(micros(100_000));
    const preview = buildUpdateStalePreview(
      plan([], {
        regenPrompt: true,
        regenTrack: true,
        sceneSummaries: [],
        analysisModelId: 'x',
        promptSource: 'regenerated',
        durationSeconds: 30,
      }),
      {},
      'cassetteai'
    );
    expect(preview.musicPrompt).toBe(true);
    expect(preview.musicTrack).toBe(true);
    expect(preview.costByLevel.music).toBe(120_000);
  });
});
