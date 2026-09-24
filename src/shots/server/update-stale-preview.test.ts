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
      dialogue: 0,
      video: 500_000,
      music: 0,
    });
  });

  it('prices dialogue on its own level, separate from video (#1703)', async () => {
    const { estimateTtsCost } = await import('@/billing/elevenlabs-pricing');
    const { ttsCharacterCount } = await import('@/motion/dialogue-tts');
    estimateVideoCost.mockReturnValue(micros(500_000));
    const voiced = [
      { shotId: 'a', index: 0, text: 'Hello there.', tone: 'calm' },
      { shotId: 'b', index: 0, text: 'General.', tone: 'dry' },
    ];
    const targets = [
      target({ shotId: 'a', regenDialogue: true, regenVideo: true }),
      target({ shotId: 'b', regenDialogue: true, regenVideo: true }),
    ];
    const preview = buildUpdateStalePreview(
      plan(targets, null, { scenes: [{ voiced }], maxDurationSeconds: 15 }),
      {},
      null
    );
    // Two renders, ONE recording of the scene's whole conversation — priced
    // on the dialogue step, not folded into video.
    expect(preview.dialogueShotIds).toEqual(['a', 'b']);
    expect(preview.costByLevel.dialogue).toBe(
      estimateTtsCost(ttsCharacterCount(voiced))
    );
    expect(preview.costByLevel.video).toBe(1_000_000);
    expect(
      buildUpdateStalePreview(plan(targets), {}, null).costByLevel.dialogue
    ).toBe(0);
  });

  it('charges a scene recording at video depth when only its video is stale (#1740)', async () => {
    const { estimateTtsCost } = await import('@/billing/elevenlabs-pricing');
    const { ttsCharacterCount } = await import('@/motion/dialogue-tts');
    estimateVideoCost.mockReturnValue(micros(500_000));
    const voicedA = [{ shotId: 'a', index: 0, text: 'Hello.', tone: 'calm' }];
    const voicedB = [{ shotId: 'b', index: 0, text: 'Goodbye.', tone: 'dry' }];
    const recording = (scenes: unknown[]) => ({
      scenes,
      maxDurationSeconds: 15,
    });

    // No dialogue target: both scenes still record before their renders.
    const videoOnly = buildUpdateStalePreview(
      plan(
        [
          target({ shotId: 'a', regenVideo: true }),
          target({ shotId: 'b', regenVideo: true }),
        ],
        null,
        recording([{ voiced: voicedA }, { voiced: voicedB }])
      ),
      {},
      null
    );
    expect(videoOnly.costByLevel.dialogue).toBe(0);
    expect(videoOnly.costByLevel.video).toBe(
      1_000_000 + estimateTtsCost(ttsCharacterCount([...voicedA, ...voicedB]))
    );

    // Scene A is a dialogue target, scene B only re-renders: each scene is
    // charged at the earliest depth that records it.
    const mixed = buildUpdateStalePreview(
      plan(
        [
          target({ shotId: 'a', regenDialogue: true, regenVideo: true }),
          target({ shotId: 'b', regenVideo: true }),
        ],
        null,
        recording([{ voiced: voicedA }, { voiced: voicedB }])
      ),
      {},
      null
    );
    expect(mixed.costByLevel.dialogue).toBe(
      estimateTtsCost(ttsCharacterCount(voicedA))
    );
    expect(mixed.costByLevel.video).toBe(
      1_000_000 + estimateTtsCost(ttsCharacterCount(voicedB))
    );

    // One scene holding both lines is recorded once, at dialogue depth.
    const sameScene = buildUpdateStalePreview(
      plan(
        [
          target({ shotId: 'a', regenDialogue: true, regenVideo: true }),
          target({ shotId: 'b', regenVideo: true }),
        ],
        null,
        recording([{ voiced: [...voicedA, ...voicedB] }])
      ),
      {},
      null
    );
    expect(sameScene.costByLevel.dialogue).toBe(
      estimateTtsCost(ttsCharacterCount([...voicedA, ...voicedB]))
    );
    expect(sameScene.costByLevel.video).toBe(1_000_000);
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
