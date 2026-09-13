/**
 * Cost estimation for pre-flight credit gates. Returns Microdollars, or null
 * when no honest estimate exists (#1069; see `estimateFalCost`).
 *
 * `pricing` is REQUIRED on every estimator — server paths pass
 * `getEffectiveFalPricing()`, tests pass a fixture. A default would let a
 * call site silently estimate on stale data. Estimators stay synchronous.
 */

import { estimateFalCost, type EffectiveFalPricing } from './fal-cost';
import {
  getEditEndpoint,
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  supportsReferenceOnlyMotion,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import type { AspectRatio } from '@/models/aspect-ratios';
import { aspectRatioToDimensions } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { imageRequestDimensions } from '@/stills/build-image-request';
import { resolveMotionEndpoint } from '@/motion/resolve-motion-endpoint';
import {
  studioVideoEndpointId,
  type StudioVideoMode,
} from '@/studio/text-to-video';
import { getLogger } from '@/platform/logger';
import {
  shouldRunStage,
  stageIndex,
  type GenerationStage,
} from '@/sequences/pipeline';
import { reportFlooredEstimate } from './billing-observability';
import {
  estimateTtsCost,
  TYPICAL_DIALOGUE_CHARS_PER_SHOT,
  VOICE_DESIGN_COST,
} from './elevenlabs-pricing';
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
  | 'storyboard:element-sheets'
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
  opts: { pricing: FalPricingMap; resolution?: Resolution; edit?: boolean }
): Microdollars | null {
  // Megapixel-priced endpoints bill on the pixels actually requested, so the
  // tier has to size the estimate — a 4K ask against the flat 1600×900 stand-in
  // under-quotes by ~5.8× and under-reserves the credits gating it (#1449).
  // Asked of the request builder rather than derived here, so a model the tier
  // can't resize is still quoted at the size it really renders.
  const { width, height } =
    imageRequestDimensions(model, aspectRatio, opts.resolution) ??
    aspectRatioToDimensions(aspectRatio);

  // Always the fal catalog id: when the platform routes this model to BytePlus
  // Ark, the pricing map already aliases that id to the Ark rate (#1157), so
  // no call site has to know the route.
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
 * reference-to-video endpoint (Seedance, H3 Max), use that row; otherwise
 * the base image-to-video id. Duration + resolution still drive the unit
 * formula — we do not invent a per-ref surcharge.
 */
export function estimateVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts: {
    pricing: FalPricingMap;
    resolution?: Resolution;
    /**
     * True when cast/element (or other) reference images will be sent so
     * `resolveMotionEndpoint` may route to reference-to-video.
     */
    hasReferenceImages?: boolean;
    /**
     * Reference-only shots route to reference-to-video (or, with no sheets
     * matched, its text-to-video sibling — #1521), so the estimate has to be
     * told: resolving on `hasReferenceImages` alone would price the
     * image-to-video row for a job that never runs there.
     */
    referenceOnly?: boolean;
  }
): Microdollars | null {
  // Gated on the model: `resolveMotionEndpoint` THROWS for reference-only on
  // a model with no fal reference-to-video route, and an estimator must not.
  // Grok reference-only is exactly that case — it runs on the native xAI via,
  // whose cost is the flat per-second rate off `modelConfig.id` anyway.
  const referenceOnly =
    opts.referenceOnly === true && supportsReferenceOnlyMotion(model);
  const { endpointId } = resolveMotionEndpoint(
    model,
    // A caller that has not matched sheets yet assumes a reference-only shot
    // will bind some: r2v is the conservative quote, and the t2v sibling
    // (#1521) is only priced when the caller KNOWS nothing matched.
    opts.hasReferenceImages ?? referenceOnly,
    'fal',
    referenceOnly
  );
  // Keep the catalog model id path when unresolved (tests / unknown keys).
  // Both ids alias to the Ark rate when the platform routes there (#1157).
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
  opts: {
    pricing: FalPricingMap;
    mode?: StudioVideoMode;
    resolution?: Resolution;
  }
): Microdollars | null {
  return estimateFalCost(
    studioVideoEndpointId(model, opts.mode),
    { durationSeconds, resolution: opts.resolution },
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
   * Output resolution tier (#1449). Sizes the stills and clips this estimate
   * gates; omitted, everything is quoted at the default tier and a 4K run
   * under-reserves.
   */
  resolution?: Resolution;
  /**
   * Expected still count (≈ scene count today). Prefer labeled Scene N
   * headings from Enhance over word heuristics.
   */
  estimatedSceneCount?: number;
  autoGenerateMotion?: boolean;
  /** How far the run will go (#1408). Overrides auto-generate flags. */
  stopAt?: GenerationStage;
  /** Continue-from: skip stages before this (#1408). */
  startFrom?: GenerationStage;
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
  /**
   * Reference-only: no shot stills are rendered, so the image line is zero and
   * motion prices on the reference-to-video route. Without it the quote — and
   * the reservation built on it — bills a full set of images the mode never
   * generates, which is most of what makes reference-only cheaper.
   */
  referenceOnly?: boolean;
  /**
   * Voices (#1553): one Voice Design call per speaking character in the
   * references stage. Pre-flight cannot know who speaks, so it prices every
   * estimated character — the in-run gate replaces that with the real count.
   */
  generateVoices?: boolean;
  /** Live pricing map from `getEffectiveFalPricing()`. */
  pricing: FalPricingMap;
};

/** Whether this estimate's slice includes `stage`. */
function estimateRunsStage(
  opts: Pick<
    StoryboardCostOpts,
    'startFrom' | 'stopAt' | 'autoGenerateMotion' | 'autoGenerateMusic'
  >,
  stage: GenerationStage
): boolean {
  const startFrom = opts.startFrom ?? 'script';
  if (opts.stopAt) {
    return shouldRunStage(startFrom, opts.stopAt, stage);
  }
  if (stageIndex(stage) < stageIndex(startFrom)) return false;
  if (stage === 'motion') return Boolean(opts.autoGenerateMotion);
  if (stage === 'music') return Boolean(opts.autoGenerateMusic);
  return true;
}

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

  // Reference-only renders straight to video: the shot-images phase never
  // spawns (see `analyze-script-workflow` phase 4), so there is nothing to bill.
  let totalCost = micros(0);
  if (!opts.referenceOnly && estimateRunsStage(opts, 'images')) {
    totalCost = multiplyMicros(
      gateEstimate(
        estimateImageCost(opts.imageModel, opts.aspectRatio, sceneCount, {
          pricing,
          resolution: opts.resolution,
        }),
        { model: opts.imageModel, operation: 'storyboard:shot-images' },
        sceneCount
      ),
      imageModelCount
    );
  }

  if (estimateRunsStage(opts, 'motion') && opts.videoModels?.length) {
    const duration = opts.videoDurationSeconds ?? 5;
    for (const model of opts.videoModels) {
      const perShotMotion = gateEstimate(
        estimateVideoCost(model, duration, {
          pricing,
          resolution: opts.resolution,
          hasReferenceImages: true,
          referenceOnly: opts.referenceOnly,
        }),
        { model, operation: 'storyboard:motion' }
      );
      totalCost = addMicros(
        totalCost,
        multiplyMicros(perShotMotion, sceneCount)
      );
    }
    // Dialogue TTS (#1554) rides the motion stage: one clip per line, billed
    // per character. Pre-flight cannot see the lines, so it prices a long
    // line per estimated shot; the trigger reservation uses the real count.
    if (opts.generateVoices) {
      totalCost = addMicros(
        totalCost,
        estimateTtsCost(sceneCount * TYPICAL_DIALOGUE_CHARS_PER_SHOT)
      );
    }
  }

  if (estimateRunsStage(opts, 'music') && opts.audioModels?.length) {
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
/**
 * Character + location + element reference sheets, priced per image.
 *
 * Two callers with very different information. Pre-flight only has the script,
 * so it passes the `estimate*SheetCount(sceneCount)` heuristics. The in-run
 * gate runs after casting, where the counts are FACTS — one sheet per bible
 * entry, minus the characters whose matched talent sheet is reused (a storage
 * copy, no generation) — so it passes those instead. Sheets are always square
 * 16:9 regardless of the sequence's ratio.
 */
export function estimateReferenceSheetCost(opts: {
  imageModel: TextToImageModel;
  characterSheets: number;
  locationSheets: number;
  /** Auto-generated element references (#835). Zero at pre-flight: unknowable. */
  elementSheets?: number;
  pricing: FalPricingMap;
}): Microdollars {
  const { imageModel, pricing } = opts;
  const line = (count: number, operation: GateOperation): Microdollars =>
    count <= 0
      ? micros(0)
      : gateEstimate(
          estimateImageCost(imageModel, '16:9', count, { pricing }),
          { model: imageModel, operation },
          count
        );

  return addMicros(
    addMicros(
      line(opts.characterSheets, 'storyboard:character-sheets'),
      line(opts.locationSheets, 'storyboard:location-sheets')
    ),
    line(opts.elementSheets ?? 0, 'storyboard:element-sheets')
  );
}

export function estimateStoryboardCost(opts: StoryboardCostOpts): Microdollars {
  const sceneCount = opts.estimatedSceneCount ?? DEFAULT_ESTIMATED_SCENE_COUNT;
  const { pricing } = opts;

  // The script stage always runs scene-split's three calls: scenes, bibles,
  // shot-list (which also carries the dialogue, #1585). Talent and location
  // matching only call the LLM when the user pre-cast talent or has library
  // locations, and those outputs are short, so three stand-ins cover the
  // common case.
  const llmCalls = estimateRunsStage(opts, 'script') ? 3 : 0;
  const llmCost = estimateLLMCost(llmCalls);

  const runsReferences = estimateRunsStage(opts, 'references');
  const sheetCost = runsReferences
    ? estimateReferenceSheetCost({
        imageModel: opts.imageModel,
        characterSheets: estimateCharacterSheetCount(sceneCount),
        locationSheets: estimateLocationSheetCount(sceneCount),
        pricing,
      })
    : micros(0);
  const voiceCost =
    runsReferences && opts.generateVoices
      ? multiplyMicros(
          VOICE_DESIGN_COST,
          estimateCharacterSheetCount(sceneCount)
        )
      : micros(0);

  return addMicros(
    addMicros(llmCost, addMicros(sheetCost, voiceCost)),
    estimateStoryboardRenderCost(opts)
  );
}
