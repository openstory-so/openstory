import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '@/lib/ai/models';
import { estimateStoryboardCost } from '@/lib/billing/cost-estimation';
import { estimateStoryboardPreflightCost } from '@/lib/billing/storyboard-preflight-cost';
import { estimateSceneCount } from '@/lib/generation/time-estimate';

const base = {
  imageModel: DEFAULT_IMAGE_MODEL,
  aspectRatio: '16:9' as const,
  pricing: FAL_PRICING,
};

describe('estimateStoryboardPreflightCost', () => {
  it('uses target duration for pre-Enhance short scripts (aligns with ActionCost)', () => {
    const script = 'A detective finds a letter under the door.';
    const withDuration = estimateStoryboardPreflightCost({
      ...base,
      script,
      targetDurationSeconds: 30,
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    const expected = estimateStoryboardCost({
      ...base,
      estimatedSceneCount: estimateSceneCount(script, {
        targetDurationSeconds: 30,
      }),
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    expect(withDuration).toBe(expected);
    expect(
      estimateSceneCount(script, { targetDurationSeconds: 30 })
    ).toBeGreaterThan(estimateSceneCount(script));
  });

  it('only bills motion when autoGenerateMotion is true', () => {
    const script = 'Scene 1 — 5s\nA room.\n\nScene 2 — 5s\nAnother room.';
    const stills = Number(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        autoGenerateMotion: false,
        videoModels: [DEFAULT_VIDEO_MODEL],
      })
    );
    const withMotion = Number(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        autoGenerateMotion: true,
        videoModels: [DEFAULT_VIDEO_MODEL],
      })
    );
    expect(withMotion).toBeGreaterThan(stills);
  });

  it('ignores videoModels when motion is off (regenerate dead-arg trap)', () => {
    const script = 'Scene 1 — 5s\nA room.';
    const stills = estimateStoryboardPreflightCost({
      ...base,
      script,
      autoGenerateMotion: false,
    });
    const withDeadVideoModels = estimateStoryboardPreflightCost({
      ...base,
      script,
      autoGenerateMotion: false,
      videoModels: [DEFAULT_VIDEO_MODEL],
    });
    expect(withDeadVideoModels).toBe(stills);
  });

  it('requires motion for music billing', () => {
    const script = 'Scene 1 — 5s\nA room.';
    const stills = Number(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        autoGenerateMotion: false,
        autoGenerateMusic: true,
        audioModels: [DEFAULT_MUSIC_MODEL],
      })
    );
    const motionOnly = Number(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        autoGenerateMotion: true,
        videoModels: [DEFAULT_VIDEO_MODEL],
        autoGenerateMusic: false,
        audioModels: [DEFAULT_MUSIC_MODEL],
      })
    );
    const motionAndMusic = Number(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        autoGenerateMotion: true,
        videoModels: [DEFAULT_VIDEO_MODEL],
        autoGenerateMusic: true,
        audioModels: [DEFAULT_MUSIC_MODEL],
        targetDurationSeconds: 30,
      })
    );
    expect(stills).toBeLessThan(motionOnly);
    expect(motionAndMusic).toBeGreaterThan(motionOnly);
  });
});
