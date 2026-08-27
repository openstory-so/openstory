import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
  isNativeBytePlusVideoModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  videoModelSupportsAudio,
} from './models';

describe('Seedance catalog split', () => {
  it('sends 2.5 to 2.5 and 2.0 to 2.0 enterprise', () => {
    expect(IMAGE_TO_VIDEO_MODELS.seedance_v2_5.id).toBe(
      'bytedance/seedance-2.5/image-to-video'
    );
    expect(MOTION_REFERENCE_ENDPOINTS.seedance_v2_5?.endpointId).toBe(
      'bytedance/seedance-2.5/reference-to-video'
    );
    expect(IMAGE_TO_VIDEO_MODELS.seedance_v2.id).toBe(
      'bytedance/seedance-2.0/enterprise/v2/image-to-video'
    );
    expect(MOTION_REFERENCE_ENDPOINTS.seedance_v2?.endpointId).toBe(
      'bytedance/seedance-2.0/enterprise/v2/reference-to-video'
    );
    expect(isNativeBytePlusVideoModel('seedance_v2_5')).toBe(true);
    expect(isNativeBytePlusVideoModel('seedance_v2')).toBe(false);
    expect(DEFAULT_VIDEO_MODEL).toBe('seedance_v2');
    expect('hidden' in IMAGE_TO_VIDEO_MODELS.seedance_v2_5).toBe(true);
    expect('hidden' in IMAGE_TO_VIDEO_MODELS.seedance_v2).toBe(false);
  });
});

describe('videoModelSupportsAudio', () => {
  it('returns true for audio-capable video models', () => {
    expect(videoModelSupportsAudio('seedance_v2')).toBe(true);
    expect(videoModelSupportsAudio('seedance_v2_5')).toBe(true);
    expect(videoModelSupportsAudio('kling_v3_pro')).toBe(true);
    expect(videoModelSupportsAudio('veo3_1')).toBe(true);
  });

  it('returns false for models without audio', () => {
    expect(videoModelSupportsAudio('grok_imagine_video_1_5')).toBe(false);
  });
});

describe('Model Validation', () => {
  describe('isValidTextToImageModel', () => {
    it('returns true for valid model keys', () => {
      expect(isValidTextToImageModel('nano_banana_2')).toBe(true);
      expect(isValidTextToImageModel('nano_banana_pro')).toBe(true);
      expect(isValidTextToImageModel('flux_2_dev')).toBe(true);
    });

    it('returns false for invalid model keys', () => {
      expect(isValidTextToImageModel('invalid_model')).toBe(false);
      expect(isValidTextToImageModel('flux_pro_invalid')).toBe(false);
      expect(isValidTextToImageModel('')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isValidTextToImageModel(null)).toBe(false);
      expect(isValidTextToImageModel(undefined)).toBe(false);
    });
  });

  describe('isValidImageToVideoModel', () => {
    it('returns true for valid model keys', () => {
      expect(isValidImageToVideoModel('kling_v3_pro')).toBe(true);
      expect(isValidImageToVideoModel('veo3_1')).toBe(true);
      expect(isValidImageToVideoModel('seedance_v2')).toBe(true);
      expect(isValidImageToVideoModel('seedance_v2_5')).toBe(true);
    });

    it('returns false for invalid model keys', () => {
      expect(isValidImageToVideoModel('invalid_model')).toBe(false);
      expect(isValidImageToVideoModel('wan_invalid')).toBe(false);
      expect(isValidImageToVideoModel('')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isValidImageToVideoModel(null)).toBe(false);
      expect(isValidImageToVideoModel(undefined)).toBe(false);
    });
  });

  describe('safeTextToImageModel', () => {
    it('returns the model key when valid', () => {
      expect(safeTextToImageModel('nano_banana_2')).toBe('nano_banana_2');
      expect(safeTextToImageModel('nano_banana_pro')).toBe('nano_banana_pro');
    });

    it('returns default when invalid', () => {
      expect(safeTextToImageModel('invalid_model')).toBe(DEFAULT_IMAGE_MODEL);
      expect(safeTextToImageModel('')).toBe(DEFAULT_IMAGE_MODEL);
      expect(safeTextToImageModel(null)).toBe(DEFAULT_IMAGE_MODEL);
      expect(safeTextToImageModel(undefined)).toBe(DEFAULT_IMAGE_MODEL);
    });

    it('uses custom fallback when provided', () => {
      const customFallback = 'flux_2_dev';
      expect(safeTextToImageModel('invalid_model', customFallback)).toBe(
        customFallback
      );
    });

    it('validates all IMAGE_MODELS keys', () => {
      for (const key of Object.keys(IMAGE_MODELS)) {
        expect(safeTextToImageModel(key) as string).toBe(key);
      }
    });
  });

  describe('safeImageToVideoModel', () => {
    it('returns the model key when valid', () => {
      expect(safeImageToVideoModel('kling_v3_pro')).toBe('kling_v3_pro');
      expect(safeImageToVideoModel('veo3_1')).toBe('veo3_1');
    });

    it('returns default when invalid', () => {
      expect(safeImageToVideoModel('invalid_model')).toBe(DEFAULT_VIDEO_MODEL);
      expect(safeImageToVideoModel('')).toBe(DEFAULT_VIDEO_MODEL);
      expect(safeImageToVideoModel(null)).toBe(DEFAULT_VIDEO_MODEL);
      expect(safeImageToVideoModel(undefined)).toBe(DEFAULT_VIDEO_MODEL);
    });

    it('uses custom fallback when provided', () => {
      const customFallback = 'veo3_1';
      expect(safeImageToVideoModel('invalid_model', customFallback)).toBe(
        customFallback
      );
    });

    it('validates all IMAGE_TO_VIDEO_MODELS keys', () => {
      for (const key of Object.keys(IMAGE_TO_VIDEO_MODELS)) {
        expect(safeImageToVideoModel(key) as string).toBe(key);
      }
    });
  });

  describe('Type Guards', () => {
    it('isValidTextToImageModel acts as a type guard', () => {
      const maybeModel: string = 'nano_banana_2';
      if (isValidTextToImageModel(maybeModel)) {
        // TypeScript should infer maybeModel as TextToImageModel here
        const model = maybeModel;
        expect(IMAGE_MODELS[model]).toBeDefined();
      }
    });

    it('isValidImageToVideoModel acts as a type guard', () => {
      const maybeModel: string = 'kling_v3_pro';
      if (isValidImageToVideoModel(maybeModel)) {
        // TypeScript should infer maybeModel as ImageToVideoModel here
        const model = maybeModel;
        expect(IMAGE_TO_VIDEO_MODELS[model]).toBeDefined();
      }
    });
  });
});
