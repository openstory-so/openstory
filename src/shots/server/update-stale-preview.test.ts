import { describe, expect, it, vi } from 'vitest';
import { micros } from '@/billing/money';

const { estimateImageCost, estimateVideoCost, estimateAudioCost } = vi.hoisted(
  () => ({
    estimateImageCost: vi.fn(),
    estimateVideoCost: vi.fn(),
    estimateAudioCost: vi.fn(),
  })
);
vi.mock('@/billing/cost-estimation', async (importOriginal) => ({
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

const plan = (
  targets: unknown[],
  music: unknown = null,
  dialogueRecording: unknown = null
) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  ({
    aspectRatio: '16:9',
    sequence: { videoModel: 'seedance_v2' },
    targets,
    music,
    dialogueRecording,
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

  it('prices dialogue once per scene, on the video level (#1657)', async () => {
    const { estimateTtsCost } = await import('@/billing/elevenlabs-pricing');
    const { ttsCharacterCount } = await import('@/motion/dialogue-tts');
    estimateVideoCost.mockReturnValue(micros(500_000));
    const voiced = [
      { shotId: 'a', index: 0, text: 'Hello there.', tone: 'calm' },
      { shotId: 'b', index: 0, text: 'General.', tone: 'dry' },
    ];
    const targets = [
      target({ shotId: 'a', regenVideo: true }),
      target({ shotId: 'b', regenVideo: true }),
    ];
    const preview = buildUpdateStalePreview(
      plan(targets, null, { scenes: [{ voiced }], maxDurationSeconds: 15 }),
      {},
      null
    );
    // Two renders, ONE recording of the scene's whole conversation.
    expect(preview.costByLevel.video).toBe(
      1_000_000 + estimateTtsCost(ttsCharacterCount(voiced))
    );
    expect(
      buildUpdateStalePreview(plan(targets), {}, null).costByLevel.video
    ).toBe(1_000_000);
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
