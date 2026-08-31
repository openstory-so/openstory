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
  constrainAnalysisModels,
  constrainAudioModels,
  constrainImageModels,
  constrainVideoModels,
  DEFAULT_GENERATION_MODE,
  TURBO_ANALYSIS_MODELS,
  TURBO_AUDIO_MODELS,
  TURBO_DEFAULT_ANALYSIS,
  TURBO_DEFAULT_AUDIO,
  TURBO_DEFAULT_IMAGE,
  TURBO_DEFAULT_VIDEO,
  TURBO_IMAGE_MODELS,
  TURBO_VIDEO_MODELS,
} from './generation-mode';

describe('constrainAnalysisModels', () => {
  it('keeps a quality-catalog pick in quality mode', () => {
    expect(
      constrainAnalysisModels('quality', ['anthropic/claude-fable-5'])
    ).toEqual(['anthropic/claude-fable-5']);
  });

  it('remaps a quality-only analysis model to Luna in turbo', () => {
    expect(
      constrainAnalysisModels('turbo', ['anthropic/claude-fable-5'])
    ).toEqual([TURBO_DEFAULT_ANALYSIS]);
  });

  it('keeps Luna when switching to turbo', () => {
    expect(constrainAnalysisModels('turbo', ['openai/gpt-5.6-luna'])).toEqual([
      'openai/gpt-5.6-luna',
    ]);
  });
});

describe('constrainImageModels', () => {
  it('remaps GPT Image 2 to Nano Banana 2 Lite in turbo', () => {
    expect(constrainImageModels('turbo', ['gpt_image_2'])).toEqual([
      TURBO_DEFAULT_IMAGE,
    ]);
    expect(TURBO_DEFAULT_IMAGE).toBe('nano_banana_2_lite');
  });

  it('keeps Nano Banana 2 Lite in turbo', () => {
    expect(constrainImageModels('turbo', ['nano_banana_2_lite'])).toEqual([
      'nano_banana_2_lite',
    ]);
  });
});

describe('constrainVideoModels', () => {
  it('remaps Seedance to H3 Max in turbo', () => {
    expect(constrainVideoModels('turbo', ['seedance_v2'], '16:9')).toEqual([
      TURBO_DEFAULT_VIDEO,
    ]);
    expect(TURBO_DEFAULT_VIDEO).toBe('minimax_h3_max');
  });
});

describe('constrainAudioModels', () => {
  it('keeps ElevenLabs in turbo', () => {
    expect(constrainAudioModels('turbo', ['elevenlabs_music'])).toEqual([
      TURBO_DEFAULT_AUDIO,
    ]);
    expect(TURBO_DEFAULT_AUDIO).toBe('elevenlabs_music');
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

describe('applyGenerationMode', () => {
  it('filters every catalog when entering turbo', () => {
    const next = applyGenerationMode(
      {
        generationMode: 'quality',
        analysisModels: ['anthropic/claude-fable-5'],
        imageModels: ['gpt_image_2'],
        videoModels: ['seedance_v2'],
        audioModels: ['elevenlabs_music'],
        aspectRatio: '16:9',
      },
      'turbo'
    );
    expect(next.generationMode).toBe('turbo');
    expect(next.analysisModels).toEqual([TURBO_DEFAULT_ANALYSIS]);
    expect(next.imageModels).toEqual([TURBO_DEFAULT_IMAGE]);
    expect(next.videoModels).toEqual([TURBO_DEFAULT_VIDEO]);
    expect(next.audioModels).toEqual([TURBO_DEFAULT_AUDIO]);
  });
});
