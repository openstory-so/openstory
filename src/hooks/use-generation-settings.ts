import {
  getCompatibleModel,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  referenceOnlyCapableWith,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  applyGenerationMode,
  DEFAULT_GENERATION_MODE,
  isGenerationMode,
  TURBO_DEFAULT_ANALYSIS,
  TURBO_DEFAULT_AUDIO,
  TURBO_DEFAULT_IMAGE,
  TURBO_DEFAULT_VIDEO,
  type GenerationMode,
} from '@/lib/ai/generation-mode';
import {
  isSelectableAnalysisModelId,
  isValidAnalysisModelId,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import {
  DEFAULT_RESOLUTION,
  isResolution,
  type Resolution,
} from '@/lib/constants/resolutions';
import { useCallback, useEffect, useState } from 'react';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-generation-settings']);

// Bump when product defaults change so prior localStorage snapshots are ignored
// (v4 → v5: Turbo is the product default). Adding a FIELD is not a reason to
// bump — `loadSettings` falls back per-field, so an older snapshot still loads.
// Bumping strands e2e's pinned settings (`GENERATION_SETTINGS_KEY` in
// e2e/fixtures/test-utils.ts mirrors this literal), which silently reverts the
// recorded pipeline to Turbo defaults and fails as an aimock fixture miss.
const STORAGE_KEY = 'openstory:generation-settings:v5';

type GenerationSettings = {
  generationMode: GenerationMode;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  analysisModels: AnalysisModelId[];
  imageModel: TextToImageModel;
  imageModels: TextToImageModel[];
  motionModel: ImageToVideoModel;
  videoModels: ImageToVideoModel[];
  autoGenerateMotion: boolean;
  /** Render a still per shot first (the frame-based workflow); off = reference-only. */
  generateStartFrames: boolean;
  musicModel: AudioModel;
  audioModels: AudioModel[];
  autoGenerateMusic: boolean;
};

function withMode(settings: GenerationSettings): GenerationSettings {
  const lists = applyGenerationMode(
    {
      generationMode: settings.generationMode,
      analysisModels: settings.analysisModels,
      imageModels: settings.imageModels,
      videoModels: settings.videoModels,
      audioModels: settings.audioModels,
      aspectRatio: settings.aspectRatio,
    },
    settings.generationMode
  );
  return {
    ...settings,
    ...lists,
    imageModel: lists.imageModels[0] ?? settings.imageModel,
    motionModel: lists.videoModels[0] ?? settings.motionModel,
    musicModel: lists.audioModels[0] ?? settings.musicModel,
  };
}

const DEFAULT_SETTINGS: GenerationSettings = withMode({
  generationMode: DEFAULT_GENERATION_MODE,
  aspectRatio: DEFAULT_ASPECT_RATIO,
  resolution: DEFAULT_RESOLUTION,
  analysisModels: [TURBO_DEFAULT_ANALYSIS],
  imageModel: TURBO_DEFAULT_IMAGE,
  imageModels: [TURBO_DEFAULT_IMAGE],
  motionModel: TURBO_DEFAULT_VIDEO,
  videoModels: [TURBO_DEFAULT_VIDEO],
  // Motion + music on by default so the first Generate is a short film aha
  // (welcome grant sized for a ~30s stills+motion+music board — #1140).
  autoGenerateMotion: true,
  // Off by default: a new sequence renders reference-only; start frames are
  // the opt-in for steerable composition.
  generateStartFrames: false,
  musicModel: TURBO_DEFAULT_AUDIO,
  audioModels: [TURBO_DEFAULT_AUDIO],
  autoGenerateMusic: true,
});

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
    (id) => typeof id === 'string' && isValidAnalysisModelId(id)
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

    const storedAnalysisModels = isValidAnalysisModels(parsed.analysisModels)
      ? parsed.analysisModels.filter(isSelectableAnalysisModelId)
      : [];
    const analysisModels =
      storedAnalysisModels.length > 0
        ? storedAnalysisModels
        : [TURBO_DEFAULT_ANALYSIS];

    const imageModel = isValidTextToImageModel(parsed.imageModel)
      ? parsed.imageModel
      : TURBO_DEFAULT_IMAGE;

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
      : TURBO_DEFAULT_VIDEO;

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
        : TURBO_DEFAULT_AUDIO;

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

    const bag: Record<string, unknown> = parsed;
    const generationMode = isGenerationMode(bag.generationMode)
      ? bag.generationMode
      : DEFAULT_GENERATION_MODE;
    const resolution = isResolution(bag.resolution)
      ? bag.resolution
      : DEFAULT_RESOLUTION;

    const settings = withMode({
      generationMode,
      aspectRatio,
      resolution,
      analysisModels,
      imageModel,
      imageModels,
      motionModel,
      videoModels,
      autoGenerateMotion,
      generateStartFrames:
        'generateStartFrames' in parsed &&
        typeof parsed.generateStartFrames === 'boolean'
          ? parsed.generateStartFrames
          : false,
      musicModel,
      audioModels,
      autoGenerateMusic,
    });

    // A stored selection can predate the mode, or predate a model losing its
    // reference-to-video route — either way, restoring it would hand the
    // create schema a selection it rejects. Checked against the post-`withMode`
    // list, since the mode can swap the video models out from under it. Asks
    // the same via-aware question as `createSequenceSchema` (not the model-only
    // floor): Grok Imagine is accepted by the server and must not be flipped
    // back to start frames on reload.
    return !settings.generateStartFrames &&
      !settings.videoModels.every((model) =>
        referenceOnlyCapableWith(model, { xai: true })
      )
      ? { ...settings, generateStartFrames: true }
      : settings;
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

      updated = withMode(updated);

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
