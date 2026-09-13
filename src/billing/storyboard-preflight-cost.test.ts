import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from './fal-pricing-fixture';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '@/models/models';
import {
  estimateCharacterSheetCount,
  estimateStoryboardCost,
} from './cost-estimation';
import {
  estimateTtsCost,
  TYPICAL_DIALOGUE_CHARS_PER_SHOT,
  VOICE_DESIGN_COST,
} from './elevenlabs-pricing';
import { multiplyMicros } from './money';
import { estimateStoryboardPreflightCost } from './storyboard-preflight-cost';
import { estimateSceneCount } from '@/sequences/time-estimate';

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

  it('bills a labelled multi-shot scene as N clips, not 1 heading (#1593)', () => {
    const oneShot = [
      'Scene 1 — 10s',
      'INT. HALLWAY - NIGHT',
      'She opens the door.',
    ].join('\n');
    const twoShot = [
      'Scene 1 — 10s',
      'INT. HALLWAY - NIGHT',
      'Shot 1 — 4s',
      'She opens the door.',
      'Shot 2 — 6s',
      'Cut to the hallway beyond.',
    ].join('\n');
    const quote = (script: string) =>
      Number(
        estimateStoryboardPreflightCost({
          ...base,
          script,
          autoGenerateMotion: true,
          videoModels: [DEFAULT_VIDEO_MODEL],
        })
      );
    expect(quote(twoShot)).toBeGreaterThan(quote(oneShot));
  });

  it('bills mixed Enhance labels as per-scene clips, not film-wide shot labels', () => {
    const oneShotScenes = [
      'Scene 1 — 10s',
      'She opens the door.',
      'Scene 2 — 8s',
      'She waits.',
      'Scene 3 — 5s',
      'A glance.',
    ].join('\n');
    const mixed = [
      'Scene 1 — 10s',
      'Shot 1 — 4s',
      'She opens the door.',
      'Shot 2 — 6s',
      'Cut to the hallway beyond.',
      'Scene 2 — 8s',
      'She waits.',
      'Scene 3 — 5s',
      'A glance.',
    ].join('\n');
    const quote = (script: string) =>
      Number(
        estimateStoryboardPreflightCost({
          ...base,
          script,
          autoGenerateMotion: true,
          videoModels: [DEFAULT_VIDEO_MODEL],
        })
      );
    // 4 clips (2+1+1) must quote more than 3 one-shot headings. Film-wide
    // parseClipDurationLabels used to return only [4, 6] and under-bill.
    expect(quote(mixed)).toBeGreaterThan(quote(oneShotScenes));
  });

  it('a known shotCount wins over heading count', () => {
    const script = 'Scene 1 — 10s\nINT. HALL - NIGHT\nShe opens the door.';
    const quote = (shotCount?: number) =>
      Number(
        estimateStoryboardPreflightCost({
          ...base,
          script,
          autoGenerateMotion: true,
          videoModels: [DEFAULT_VIDEO_MODEL],
          shotCount,
        })
      );
    expect(quote(5)).toBeGreaterThan(quote());
  });

  it('treats a target under 5s as auto', () => {
    const script = 'A detective finds a letter under the door.';
    const auto = estimateStoryboardPreflightCost({
      ...base,
      script,
      autoGenerateMotion: false,
    });
    const zero = estimateStoryboardPreflightCost({
      ...base,
      script,
      targetDurationSeconds: 0,
      autoGenerateMotion: false,
    });
    expect(zero).toBe(auto);
    const underFloor = estimateStoryboardPreflightCost({
      ...base,
      script,
      targetDurationSeconds: 4,
      autoGenerateMotion: false,
    });
    expect(underFloor).toBe(auto);
  });

  it('quotes a long unlabelled paste by its playing time, not a 30-scene cap (#1593)', () => {
    // ~20 pages of screenplay: 40 sluglines, ~3,600 words ≈ 20 minutes.
    const scene =
      'INT. HALL - NIGHT\n' + 'She walks the long hall. '.repeat(18);
    const feature = Array.from({ length: 40 }, () => scene).join('\n\n');
    const quote = (script: string) =>
      Number(
        estimateStoryboardPreflightCost({
          ...base,
          script,
          autoGenerateMotion: true,
          videoModels: [DEFAULT_VIDEO_MODEL],
          autoGenerateMusic: true,
          audioModels: [DEFAULT_MUSIC_MODEL],
        })
      );
    // Capped at 30 stills × 5s clips, the film quoted barely above a 30-scene
    // short. By playing time it is hundreds of clips.
    expect(quote(feature)).toBeGreaterThan(5 * quote(scene.repeat(3)));
    expect(estimateSceneCount(feature)).toBe(40);
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

  it('continue reserves only the slice from startFrom (#1408)', () => {
    const script = 'Scene 1 — 5s\nA room.';
    const full = Number(
      estimateStoryboardPreflightCost({ ...base, script, stopAt: 'images' })
    );
    const imagesOnly = Number(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        startFrom: 'images',
        stopAt: 'images',
      })
    );
    // Script LLM calls + reference sheets already ran; only stills are gated.
    expect(imagesOnly).toBeGreaterThan(0);
    expect(imagesOnly).toBeLessThan(full);

    // Reference-only never renders stills, so the same slice bills nothing.
    expect(
      Number(
        estimateStoryboardPreflightCost({
          ...base,
          script,
          startFrom: 'images',
          stopAt: 'images',
          referenceOnly: true,
        })
      )
    ).toBe(0);
  });

  it('prices one Voice Design call per estimated character when voices are on (#1553)', () => {
    const script = 'Scene 1 — 5s\nA room.\n\nScene 2 — 5s\nAnother room.';
    const off = estimateStoryboardPreflightCost({
      ...base,
      script,
      stopAt: 'references',
    });
    const on = estimateStoryboardPreflightCost({
      ...base,
      script,
      stopAt: 'references',
      generateVoices: true,
    });
    const scenes = estimateSceneCount(script);
    expect(on - off).toBe(
      multiplyMicros(VOICE_DESIGN_COST, estimateCharacterSheetCount(scenes))
    );
    // Not in the slice → not billed.
    expect(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        startFrom: 'images',
        stopAt: 'images',
        generateVoices: true,
      })
    ).toBe(
      estimateStoryboardPreflightCost({
        ...base,
        script,
        startFrom: 'images',
        stopAt: 'images',
      })
    );
  });

  it('reserves TTS on the references slice even when Voices is off (#1554)', () => {
    const script = 'Scene 1 — 5s\nA room.\n\nScene 2 — 5s\nAnother room.';
    const scriptOnly = estimateStoryboardPreflightCost({
      ...base,
      script,
      stopAt: 'script',
    });
    const refs = estimateStoryboardPreflightCost({
      ...base,
      script,
      stopAt: 'references',
    });
    const scenes = estimateSceneCount(script);
    expect(refs - scriptOnly).toBeGreaterThanOrEqual(
      estimateTtsCost(scenes * TYPICAL_DIALOGUE_CHARS_PER_SHOT)
    );
  });

  it('does not reserve TTS in the motion slice — clips are References artifacts (#1554)', () => {
    const script = 'Scene 1 — 5s\nA room.\n\nScene 2 — 5s\nAnother room.';
    const off = estimateStoryboardPreflightCost({
      ...base,
      script,
      startFrom: 'motion',
      stopAt: 'motion',
      autoGenerateMotion: true,
      videoModels: [DEFAULT_VIDEO_MODEL],
    });
    const on = estimateStoryboardPreflightCost({
      ...base,
      script,
      startFrom: 'motion',
      stopAt: 'motion',
      autoGenerateMotion: true,
      videoModels: [DEFAULT_VIDEO_MODEL],
      generateVoices: true,
    });
    expect(on).toBe(off);
  });
});
