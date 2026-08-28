/**
 * Cost estimation for pre-flight credit gates. Returns Microdollars, or null
 * when no honest estimate exists (#1069; see `estimateFalCost`).
 *
 * `pricing` is REQUIRED on every estimator — server paths pass
 * `getEffectiveFalPricing()`, tests pass a fixture. A default would let a
 * call site silently estimate on stale data. Estimators stay synchronous.
 */

import { estimateFalCost, type EffectiveFalPricing } from '@/lib/ai/fal-cost';
import {
  getEditEndpoint,
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { aspectRatioToDimensions } from '@/lib/constants/aspect-ratios';
import { resolveMotionEndpoint } from '@/lib/motion/resolve-motion-endpoint';
import {
  studioVideoEndpointId,
  type StudioVideoMode,
} from '@/lib/studio/text-to-video';
import { getLogger } from '@/lib/observability/logger';
import { reportFlooredEstimate } from './billing-observability';
import { type Microdollars, addMicros, micros, multiplyMicros } from './money';

const logger = getLogger(['openstory', 'billing', 'cost-estimation']);

type FalPricingMap = Record<string, EffectiveFalPricing>;

/**
 * Conservative per-call floor the credit gate assumes when a model has no
 * honest estimate. Over-gating slightly beats under-gating — the old
 * fabricated default gated Grok Imagine ~98× low (#1069). A model leaves the
 * floor once `MIN_OBSERVED_SAMPLES` generations are recorded AND the nightly
 * cron folds them into `model_pricing` (~5 generations + up to 24h).
 */
const UNKNOWN_ESTIMATE_FLOOR = micros(100_000); // $0.10 per call

/**
 * Operations that can gate on the unknown-estimate floor. A closed union: the
 * value is both the `reportedUnpriced` dedup key and the log-grouping
 * dimension, so a typo would fork both.
 */
type GateOperation =
  | 'add-audio-model'
  | 'add-image-model'
  | 'add-video-model'
  | 'batch-motion'
  | 'motion'
  | 'motion-workflow'
  | 'shot-image'
  | 'shot-variants'
  | 'smart-retry:image'
  | 'smart-retry:motion'
  | 'smart-retry:music'
  | 'storyboard:character-sheets'
  | 'storyboard:location-sheets'
  | 'storyboard:motion'
  | 'storyboard:music'
  | 'storyboard:shot-images'
  | 'update-stale-shots'
  | 'update-stale-shots:video'
  | 'variant-upscale'
  | 'studio-image'
  | 'studio-video';

/** Any model a fal estimate can be gated for. */
type GateModel = TextToImageModel | ImageToVideoModel | AudioModel;

/** Which model and operation a gate is standing in for. */
export type GateContext = { model: GateModel; operation: GateOperation };

/**
 * Models already reported as unpriced in this isolate — gates run inside
 * per-shot loops, so without dedup one unpriced model logs once per shot.
 */
const reportedUnpriced = new Set<string>();

/**
 * Resolve an estimate for the credit gate: the honest number when one exists,
 * otherwise the conservative floor per call.
 *
 * Prefer null for single-action UI labels (`estimateImageCost` / video / audio).
 * `estimateStoryboardCost` intentionally floors components for credit gates
 * and reuses that total for Generate's ActionCost — that dual use is the
 * exception, not the rule (#1140).
 *
 * The log dedupes per model+operation; the PostHog event fires every time so
 * the floor's frequency stays countable.
 */
export function gateEstimate(
  estimate: Microdollars | null,
  context: GateContext,
  numCalls: number = 1
): Microdollars {
  if (estimate !== null) return estimate;

  const floored = multiplyMicros(UNKNOWN_ESTIMATE_FLOOR, numCalls);
  reportFlooredEstimate({
    model: context.model,
    operation: context.operation,
    numCalls,
    floorMicros: Number(floored),
  });
  const key = `${context.model}:${context.operation}`;
  if (!reportedUnpriced.has(key)) {
    reportedUnpriced.add(key);
    logger.error(
      `No pricing signal for ${context.model} — gating ${context.operation} on the unknown-estimate floor`,
      {
        model: context.model,
        operation: context.operation,
        numCalls,
        floorMicros: Number(floored),
      }
    );
  }
  return floored;
}

/**
 * Estimate provider cost of generating images. Rough pre-flight
 * gate only — the exact charge comes from fal's reported units post-generation.
 */
export function estimateImageCost(
  model: TextToImageModel,
  aspectRatio: AspectRatio,
  numImages: number,
  opts: { pricing: FalPricingMap; resolution?: string; edit?: boolean }
): Microdollars | null {
  const { width, height } = aspectRatioToDimensions(aspectRatio);

  return estimateFalCost(
    (opts.edit ? getEditEndpoint(model) : null) ?? IMAGE_MODELS[model].id,
    {
      numImages,
      widthPx: width,
      heightPx: height,
      resolution: opts.resolution,
    },
    opts.pricing
  );
}

/**
 * Estimate provider cost of generating video.
 *
 * Prices the **endpoint the run will actually hit** (#873 / #1140): when
 * cast/element refs will be attached and the model has a dedicated
 * reference-to-video endpoint (Seedance), use that row; otherwise the base
 * image-to-video id. Duration + resolution still drive the unit formula —
 * we do not invent a per-ref surcharge.
 */
export function estimateVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts: {
    pricing: FalPricingMap;
    resolution?: string;
    /**
     * True when cast/element (or other) reference images will be sent so
     * `resolveMotionEndpoint` may route to reference-to-video.
     */
    hasReferenceImages?: boolean;
  }
): Microdollars | null {
  const { endpointId } = resolveMotionEndpoint(
    model,
    opts.hasReferenceImages === true
  );
  // Keep the catalog model id path when unresolved (tests / unknown keys).
  const falEndpointId = endpointId || IMAGE_TO_VIDEO_MODELS[model].id;
  return estimateFalCost(
    falEndpointId,
    {
      durationSeconds,
      resolution: opts.resolution,
    },
    opts.pricing
  );
}

/** Pre-flight cost of a studio clip; `mode` picks the endpoint priced. */
export function estimateStudioVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts: { pricing: FalPricingMap; mode?: StudioVideoMode }
): Microdollars | null {
  return estimateFalCost(
    studioVideoEndpointId(model, opts.mode),
    { durationSeconds },
    opts.pricing
  );
}

/**
 * Estimate provider cost of generating one music track.
 */
export function estimateAudioCost(
  model: AudioModel,
  durationSeconds: number,
  opts: { pricing: FalPricingMap }
): Microdollars | null {
  return estimateFalCost(
    AUDIO_MODELS[model].id,
    { durationSeconds },
    opts.pricing
  );
}

/**
 * Fixed pre-flight stand-in (~$0.02/call) for script-analysis LLM cost.
 * Used by credit gates and ActionCost/storyboard estimates — never for actual
 * deduction (that uses OpenRouter `usage.cost` via `llmCostFromUsage`).
 */
const AVERAGE_LLM_COST_PER_CALL_MICROS = micros(20_000); // $0.02

export function estimateLLMCost(numCalls: number = 1): Microdollars {
  return multiplyMicros(AVERAGE_LLM_COST_PER_CALL_MICROS, numCalls);
}

/**
 * Blind fallback when callers omit `estimatedSceneCount`. Prefer
 * `estimateSceneCount(script, { targetDurationSeconds })` (or labeled Scene N
 * headings after Enhance). Not the Enhance 30s product default (~5–6 shots).
 */
const DEFAULT_ESTIMATED_SCENE_COUNT = 8;

/**
 * How many character reference sheets to bill for a pre-flight estimate.
 * Always charging 3 made a 1-scene Generate quote look absurd (sheets alone
 * dominated). Scales gently with board size; caps at 3.
 */
export function estimateCharacterSheetCount(sceneCount: number): number {
  const n = Math.max(1, Math.floor(sceneCount));
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  return 3;
}

/**
 * How many location reference sheets to bill for a pre-flight estimate.
 * Same rationale as {@link estimateCharacterSheetCount}.
 */
export function estimateLocationSheetCount(sceneCount: number): number {
  const n = Math.max(1, Math.floor(sceneCount));
  if (n <= 3) return 1;
  if (n <= 8) return 2;
  return 3;
}

export type StoryboardCostOpts = {
  imageModel: TextToImageModel;
  /** Number of image models selected (multiplies per-shot image cost) */
  imageModelCount?: number;
  aspectRatio: AspectRatio;
  /**
   * Expected still count (≈ scene count today). Prefer labeled Scene N
   * headings from Enhance over word heuristics.
   */
  estimatedSceneCount?: number;
  autoGenerateMotion?: boolean;
  /**
   * Video models for per-shot motion (#545). Each is priced from its own
   * parameters — a uniform multiplier would mis-estimate a mixed selection.
   */
  videoModels?: ImageToVideoModel[];
  videoDurationSeconds?: number;
  autoGenerateMusic?: boolean;
  /**
   * Audio models for the per-sequence music track (#546). Each is priced from
   * its own parameters (ElevenLabs per-minute vs ACE-Step per-second).
   */
  audioModels?: AudioModel[];
  /** Total sequence duration in seconds (one music track spans the sequence) */
  audioDurationSeconds?: number;
  /** Live pricing map from `getEffectiveFalPricing()`. */
  pricing: FalPricingMap;
};

/**
 * Stills + optional motion + optional music for an already-split board.
 * Excludes LLM analysis and character/location sheets (those already ran).
 * Used to grow the run envelope after scene-split (#1310).
 */
export function estimateStoryboardRenderCost(
  opts: StoryboardCostOpts
): Microdollars {
  const sceneCount = opts.estimatedSceneCount ?? DEFAULT_ESTIMATED_SCENE_COUNT;
  const imageModelCount = opts.imageModelCount ?? 1;
  const { pricing } = opts;

  let totalCost = multiplyMicros(
    gateEstimate(
      estimateImageCost(opts.imageModel, opts.aspectRatio, sceneCount, {
        pricing,
      }),
      { model: opts.imageModel, operation: 'storyboard:shot-images' },
      sceneCount
    ),
    imageModelCount
  );

  if (opts.autoGenerateMotion && opts.videoModels?.length) {
    const duration = opts.videoDurationSeconds ?? 5;
    for (const model of opts.videoModels) {
      const perShotMotion = gateEstimate(
        estimateVideoCost(model, duration, {
          pricing,
          hasReferenceImages: true,
        }),
        { model, operation: 'storyboard:motion' }
      );
      totalCost = addMicros(
        totalCost,
        multiplyMicros(perShotMotion, sceneCount)
      );
    }
  }

  if (opts.autoGenerateMusic && opts.audioModels?.length) {
    const audioDuration = opts.audioDurationSeconds ?? sceneCount * 5;
    for (const model of opts.audioModels) {
      totalCost = addMicros(
        totalCost,
        gateEstimate(estimateAudioCost(model, audioDuration, { pricing }), {
          model,
          operation: 'storyboard:music',
        })
      );
    }
  }

  return totalCost;
}

/**
 * Estimate the total cost of a storyboard workflow.
 * Includes: LLM analysis, character/location sheet images, per-shot images,
 * and optionally per-shot motion generation.
 *
 * `estimatedSceneCount` is treated as the number of **shot stills** to bill
 * (today the pipeline is ~1 still per scene). Callers should pass
 * `estimateSceneCount(script, { targetDurationSeconds })` so pre-Enhance
 * duration chips and enhanced "Scene N — 5s" headings both count accurately
 * (#1140). Prefer `estimateStoryboardPreflightCost` at server gates so
 * motion/music flags stay aligned with Generate ActionCost.
 *
 * Always returns a number for gates: components with no honest estimate
 * contribute `UNKNOWN_ESTIMATE_FLOOR` per call. Generate's ActionCost and
 * film-cost showcase also use this total after an honest primary-image probe;
 * unpriced motion/audio lines may still embed floors in that composite.
 */
export function estimateStoryboardCost(opts: StoryboardCostOpts): Microdollars {
  const sceneCount = opts.estimatedSceneCount ?? DEFAULT_ESTIMATED_SCENE_COUNT;
  const { pricing } = opts;
  const characterSheets = estimateCharacterSheetCount(sceneCount);
  const locationSheets = estimateLocationSheetCount(sceneCount);

  const llmCost = estimateLLMCost(3);

  const characterSheetCost = gateEstimate(
    estimateImageCost(opts.imageModel, '16:9', characterSheets, { pricing }),
    {
      model: opts.imageModel,
      operation: 'storyboard:character-sheets',
    },
    characterSheets
  );

  const locationSheetCost = gateEstimate(
    estimateImageCost(opts.imageModel, '16:9', locationSheets, { pricing }),
    {
      model: opts.imageModel,
      operation: 'storyboard:location-sheets',
    },
    locationSheets
  );

  return addMicros(
    addMicros(addMicros(llmCost, characterSheetCost), locationSheetCost),
    estimateStoryboardRenderCost(opts)
  );
}
