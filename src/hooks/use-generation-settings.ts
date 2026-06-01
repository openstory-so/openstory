import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  getCompatibleModel,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  ANALYSIS_MODEL_IDS,
  DEFAULT_ANALYSIS_MODEL,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { useCallback, useEffect, useState } from 'react';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-generation-settings']);

const STORAGE_KEY = 'openstory:generation-settings:v2';

type GenerationSettings = {
  aspectRatio: AspectRatio;
  analysisModels: AnalysisModelId[];
  imageModel: TextToImageModel;
  imageModels: TextToImageModel[];
  motionModel: ImageToVideoModel;
  videoModels: ImageToVideoModel[];
  autoGenerateMotion: boolean;
  musicModel: AudioModel;
  audioModels: AudioModel[];
  autoGenerateMusic: boolean;
};

const DEFAULT_SETTINGS: GenerationSettings = {
  aspectRatio: DEFAULT_ASPECT_RATIO,
  analysisModels: [DEFAULT_ANALYSIS_MODEL],
  imageModel: DEFAULT_IMAGE_MODEL,
  imageModels: [DEFAULT_IMAGE_MODEL],
  motionModel: DEFAULT_VIDEO_MODEL,
  videoModels: [DEFAULT_VIDEO_MODEL],
  autoGenerateMotion: false,
  musicModel: DEFAULT_MUSIC_MODEL,
  audioModels: [DEFAULT_MUSIC_MODEL],
  autoGenerateMusic: false,
};

/**
 * Validates aspect ratio value
 */
function isValidAspectRatio(value: unknown): value is AspectRatio {
  return (
    typeof value === 'string' &&
    (value === '16:9' || value === '9:16' || value === '1:1')
  );
}

/**
 * Validates analysis model IDs array
 */
function isValidAnalysisModels(value: unknown): value is AnalysisModelId[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every(
    (id) =>
      typeof id === 'string' && ANALYSIS_MODEL_IDS.some((model) => model === id)
  );
}

/**
 * Loads settings from localStorage with validation
 */
function loadSettings(): GenerationSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_SETTINGS;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_SETTINGS;
    }

    const parsed: unknown = JSON.parse(stored);

    // Validate structure (only check core fields — new fields fall back gracefully)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('aspectRatio' in parsed) ||
      !('analysisModels' in parsed) ||
      !('imageModel' in parsed) ||
      !('motionModel' in parsed)
    ) {
      logger.warn('Invalid settings structure, using defaults');
      return DEFAULT_SETTINGS;
    }

    // Validate and sanitize each field
    const aspectRatio = isValidAspectRatio(parsed.aspectRatio)
      ? parsed.aspectRatio
      : DEFAULT_ASPECT_RATIO;

    const analysisModels = isValidAnalysisModels(parsed.analysisModels)
      ? parsed.analysisModels
      : [DEFAULT_ANALYSIS_MODEL];

    const imageModel = isValidTextToImageModel(parsed.imageModel)
      ? parsed.imageModel
      : DEFAULT_IMAGE_MODEL;

    // Load imageModels array, falling back to [imageModel] for backward compat
    const imageModels =
      'imageModels' in parsed &&
      Array.isArray(parsed.imageModels) &&
      parsed.imageModels.length > 0 &&
      parsed.imageModels.every(isValidTextToImageModel)
        ? parsed.imageModels
        : [imageModel];

    const rawMotionModel = isValidImageToVideoModel(parsed.motionModel)
      ? parsed.motionModel
      : DEFAULT_VIDEO_MODEL;

    // Ensure motion model is compatible with aspect ratio
    const motionModel = getCompatibleModel(rawMotionModel, aspectRatio);

    // Load videoModels array, falling back to [motionModel] for backward
    // compat. Coerce each element to an aspect-ratio-compatible model and
    // dedupe so a stored selection from another ratio can't surface an
    // incompatible model in the picker.
    const rawVideoModels =
      'videoModels' in parsed &&
      Array.isArray(parsed.videoModels) &&
      parsed.videoModels.length > 0 &&
      parsed.videoModels.every(isValidImageToVideoModel)
        ? parsed.videoModels
        : [motionModel];
    const videoModels = [
      ...new Set(rawVideoModels.map((m) => getCompatibleModel(m, aspectRatio))),
    ];

    const autoGenerateMotion =
      'autoGenerateMotion' in parsed &&
      typeof parsed.autoGenerateMotion === 'boolean'
        ? parsed.autoGenerateMotion
        : false;

    const musicModel =
      'musicModel' in parsed && isValidAudioModel(parsed.musicModel)
        ? parsed.musicModel
        : DEFAULT_MUSIC_MODEL;

    // Load audioModels array, falling back to [musicModel] for backward compat.
    const audioModels =
      'audioModels' in parsed &&
      Array.isArray(parsed.audioModels) &&
      parsed.audioModels.length > 0 &&
      parsed.audioModels.every(isValidAudioModel)
        ? parsed.audioModels
        : [musicModel];

    const autoGenerateMusic =
      'autoGenerateMusic' in parsed &&
      typeof parsed.autoGenerateMusic === 'boolean'
        ? parsed.autoGenerateMusic
        : false;

    return {
      aspectRatio,
      analysisModels,
      imageModel,
      imageModels,
      motionModel,
      videoModels,
      autoGenerateMotion,
      musicModel,
      audioModels,
      autoGenerateMusic,
    };
  } catch (error) {
    logger.warn('Failed to load settings from localStorage:', { err: error });
    return DEFAULT_SETTINGS;
  }
}

/**
 * Saves settings to localStorage
 */
function saveSettings(settings: GenerationSettings): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    logger.warn('Failed to save settings to localStorage:', { err: error });
  }
}

/**
 * Hook for managing generation settings with localStorage persistence
 *
 * @returns Object with current settings and save function
 */
export function useGenerationSettings() {
  // Always initialize with defaults to prevent hydration mismatch
  // localStorage values are loaded in useEffect after mount
  const [settings, setSettings] =
    useState<GenerationSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load settings on mount (client-side only)
  useEffect(() => {
    const loaded = loadSettings();
    setSettings(loaded);
    setIsLoaded(true);
  }, []);

  /**
   * Save settings to localStorage and update state
   * Auto-switches motion model if incompatible with new aspect ratio
   */
  const save = useCallback((newSettings: Partial<GenerationSettings>) => {
    setSettings((prev) => {
      let updated = { ...prev, ...newSettings };

      // If aspect ratio is changing, ensure motion model(s) are compatible
      const nextAspectRatio = newSettings.aspectRatio;
      if (nextAspectRatio && nextAspectRatio !== prev.aspectRatio) {
        const compatibleModel = getCompatibleModel(
          updated.motionModel,
          nextAspectRatio
        );
        const compatibleVideoModels = [
          ...new Set(
            updated.videoModels.map((m) =>
              getCompatibleModel(m, nextAspectRatio)
            )
          ),
        ];
        updated = {
          ...updated,
          motionModel: compatibleModel,
          videoModels: compatibleVideoModels,
        };
      }

      saveSettings(updated);
      return updated;
    });
  }, []);

  /**
   * Reset settings to defaults
   */
  const reset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  }, []);

  return {
    settings,
    isLoaded,
    save,
    reset,
  };
}
