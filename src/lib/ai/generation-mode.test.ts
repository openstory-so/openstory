import { describe, expect, it } from 'vitest';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import { isSelectableAnalysisModelId } from '@/lib/ai/models.config';
import {
  applyGenerationMode,
  compareSelectorModels,
  DEFAULT_GENERATION_MODE,
  defaultAnalysisModel,
  defaultImageModel,
  defaultVideoModel,
  isTurboImageModel,
  isTurboVideoModel,
  styleMayApplyImage,
  styleMayApplyVideo,
  QUALITY_DEFAULT_ANALYSIS,
  QUALITY_DEFAULT_IMAGE,
  QUALITY_DEFAULT_VIDEO,
  selectorGroup,
  TURBO_ANALYSIS_MODELS,
  TURBO_AUDIO_MODELS,
  TURBO_DEFAULT_ANALYSIS,
  TURBO_DEFAULT_AUDIO,
  TURBO_DEFAULT_IMAGE,
  TURBO_DEFAULT_VIDEO,
  TURBO_IMAGE_MODELS,
  TURBO_VIDEO_MODELS,
} from './generation-mode';

const baseSettings = {
  generationMode: 'quality' as const,
  analysisModels: ['anthropic/claude-fable-5' as const],
  imageModels: ['gpt_image_2' as const],
  videoModels: ['seedance_v2' as const],
  audioModels: ['elevenlabs_music' as const],
  aspectRatio: '16:9' as const,
};

describe('applyGenerationMode', () => {
  it('snaps every catalog to turbo defaults when entering turbo', () => {
    const next = applyGenerationMode(baseSettings, 'turbo');
    expect(next.generationMode).toBe('turbo');
    expect(next.analysisModels).toEqual([TURBO_DEFAULT_ANALYSIS]);
    expect(next.imageModels).toEqual([TURBO_DEFAULT_IMAGE]);
    expect(next.videoModels).toEqual([TURBO_DEFAULT_VIDEO]);
    expect(next.audioModels).toEqual([TURBO_DEFAULT_AUDIO]);
  });

  it('snaps to quality defaults when entering quality', () => {
    const next = applyGenerationMode(
      { ...baseSettings, generationMode: 'turbo' },
      'quality'
    );
    expect(next.analysisModels).toEqual([QUALITY_DEFAULT_ANALYSIS]);
    expect(next.imageModels).toEqual([QUALITY_DEFAULT_IMAGE]);
    expect(next.videoModels).toEqual([QUALITY_DEFAULT_VIDEO]);
  });

  it('keeps a quality pick while staying in turbo', () => {
    const next = applyGenerationMode(
      {
        ...baseSettings,
        generationMode: 'turbo',
        imageModels: ['gpt_image_2'],
        videoModels: ['seedance_v2'],
      },
      'turbo'
    );
    expect(next.imageModels).toEqual(['gpt_image_2']);
    expect(next.videoModels).toEqual(['seedance_v2']);
  });
});

describe('mode defaults', () => {
  it('turbo defaults are Lite / H3 Max / Luna', () => {
    expect(defaultAnalysisModel('turbo')).toBe(TURBO_DEFAULT_ANALYSIS);
    expect(defaultImageModel('turbo')).toBe(TURBO_DEFAULT_IMAGE);
    expect(defaultVideoModel('turbo', '16:9')).toBe(TURBO_DEFAULT_VIDEO);
    expect(TURBO_DEFAULT_IMAGE).toBe('nano_banana_2_lite');
    expect(TURBO_DEFAULT_VIDEO).toBe('minimax_h3_max');
  });

  it('quality defaults are Fable / GPT Image 2 / Seedance', () => {
    expect(defaultAnalysisModel('quality')).toBe('anthropic/claude-fable-5');
    expect(defaultImageModel('quality')).toBe('gpt_image_2');
    expect(defaultVideoModel('quality', '16:9')).toBe('seedance_v2');
  });
});

describe('selector grouping', () => {
  it('puts Lite in Fast and GPT Image 2 in Quality', () => {
    expect(selectorGroup('nano_banana_2_lite', TURBO_IMAGE_MODELS)).toBe(
      'fast'
    );
    expect(selectorGroup('gpt_image_2', TURBO_IMAGE_MODELS)).toBe('quality');
  });

  it('orders Fast by turbo list, then Quality with the default first', () => {
    const ids = [
      'gpt_image_2',
      'flux_2_flash',
      'nano_banana_2_lite',
      'seedream_v5',
    ];
    ids.sort((a, b) =>
      compareSelectorModels(
        a,
        b,
        TURBO_IMAGE_MODELS,
        QUALITY_DEFAULT_IMAGE,
        (id) =>
          isValidTextToImageModel(id) ? IMAGE_MODELS[id].qualityRank : 99
      )
    );
    expect(ids[0]).toBe('nano_banana_2_lite');
    expect(ids[1]).toBe('flux_2_flash');
    expect(ids[2]).toBe('gpt_image_2');
  });
});

describe('styleMayApplyImage / styleMayApplyVideo', () => {
  it('lets Quality apply any catalog model', () => {
    expect(styleMayApplyImage('quality', 'gpt_image_2')).toBe(true);
    expect(styleMayApplyVideo('quality', 'seedance_v2')).toBe(true);
  });

  it('blocks Turbo from applying a Quality-only rec', () => {
    expect(styleMayApplyImage('turbo', 'gpt_image_2')).toBe(false);
    expect(styleMayApplyImage('turbo', 'grok_imagine_image')).toBe(false);
    expect(styleMayApplyVideo('turbo', 'seedance_v2')).toBe(false);
  });

  it('allows Turbo to apply a Fast rec', () => {
    expect(styleMayApplyImage('turbo', 'nano_banana_2_lite')).toBe(true);
    expect(styleMayApplyVideo('turbo', 'minimax_h3_max')).toBe(true);
  });
});

describe('isTurboImageModel / isTurboVideoModel', () => {
  it('flags Lite and H3 Max, not GPT Image 2 or Seedance', () => {
    expect(isTurboImageModel('nano_banana_2_lite')).toBe(true);
    expect(isTurboImageModel('gpt_image_2')).toBe(false);
    expect(isTurboVideoModel('minimax_h3_max')).toBe(true);
    expect(isTurboVideoModel('seedance_v2')).toBe(false);
  });
});

describe('DEFAULT_GENERATION_MODE', () => {
  it('is turbo', () => {
    expect(DEFAULT_GENERATION_MODE).toBe('turbo');
  });
});

describe('turbo catalogs', () => {
  it('only list live, selectable models', () => {
    for (const id of TURBO_ANALYSIS_MODELS) {
      expect(isSelectableAnalysisModelId(id)).toBe(true);
    }
    for (const id of TURBO_IMAGE_MODELS) {
      expect(isValidTextToImageModel(id)).toBe(true);
      expect('hidden' in IMAGE_MODELS[id]).toBe(false);
    }
    for (const id of TURBO_VIDEO_MODELS) {
      expect(isValidImageToVideoModel(id)).toBe(true);
      expect('hidden' in IMAGE_TO_VIDEO_MODELS[id]).toBe(false);
    }
    for (const id of TURBO_AUDIO_MODELS) {
      expect(isValidAudioModel(id)).toBe(true);
      expect(AUDIO_MODELS[id].type).toBe('music');
    }
  });
});
