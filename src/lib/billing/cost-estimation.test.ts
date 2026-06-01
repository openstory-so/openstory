import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUSIC_MODEL,
  type AudioModel,
  type TextToImageModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { estimateStoryboardCost } from './cost-estimation';

const IMAGE_MODEL: TextToImageModel = 'nano_banana_2';
const VIDEO_MODEL: ImageToVideoModel = 'kling_v3_pro';
const AUDIO_MODEL: AudioModel = DEFAULT_MUSIC_MODEL;

const base = {
  imageModel: IMAGE_MODEL,
  aspectRatio: '16:9' as const,
  estimatedSceneCount: 8,
};

describe('estimateStoryboardCost', () => {
  it('multiplies the per-frame image cost by imageModelCount', () => {
    const one = Number(estimateStoryboardCost({ ...base, imageModelCount: 1 }));
    const two = Number(estimateStoryboardCost({ ...base, imageModelCount: 2 }));
    // The delta is exactly one extra set of per-frame images (character/location
    // sheets + LLM are not multiplied), so two-model cost exceeds one-model.
    expect(two).toBeGreaterThan(one);
  });

  it('multiplies the per-frame motion cost by videoModelCount', () => {
    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    const oneModel = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModel: VIDEO_MODEL,
        videoModelCount: 1,
      })
    );
    const twoModels = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModel: VIDEO_MODEL,
        videoModelCount: 2,
      })
    );
    // Each extra video model adds exactly one more full pass of per-frame
    // motion cost — the invariant the credit pre-flight relies on.
    const perModelMotionCost = oneModel - noMotion;
    expect(twoModels - oneModel).toBe(perModelMotionCost);
    expect(twoModels).toBeGreaterThanOrEqual(oneModel);
  });

  it('multiplies the per-sequence music cost by audioModelCount', () => {
    const noMusic = Number(
      estimateStoryboardCost({ ...base, autoGenerateMusic: false })
    );
    const oneModel = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMusic: true,
        audioModel: AUDIO_MODEL,
        audioModelCount: 1,
      })
    );
    const twoModels = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMusic: true,
        audioModel: AUDIO_MODEL,
        audioModelCount: 2,
      })
    );
    const perModelMusicCost = oneModel - noMusic;
    expect(twoModels - oneModel).toBe(perModelMusicCost);
    expect(twoModels).toBeGreaterThanOrEqual(oneModel);
  });

  it('defaults videoModelCount/imageModelCount to 1 when omitted', () => {
    const explicit = Number(
      estimateStoryboardCost({
        ...base,
        imageModelCount: 1,
        autoGenerateMotion: true,
        videoModel: VIDEO_MODEL,
        videoModelCount: 1,
      })
    );
    const omitted = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModel: VIDEO_MODEL,
      })
    );
    expect(omitted).toBe(explicit);
  });
});
