/**
 * Type definitions for QStash Workflows
 */

import type {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  ImageToVideoModel,
  TextToImageModel,
} from '@/lib/ai/models';
import type { AnalysisModelId } from '@/lib/ai/models.config';
import type {
  AssemblableMotionPrompt,
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  MotionAudio,
  MotionDialogue,
  MotionPrompt,
  Scene,
  VisualPrompt,
} from '@/lib/ai/scene-analysis.schema';

/**
 * Structured motion direction (dialogue + audio) carried forward onto a
 * user-edit motion prompt version. Captured at trigger time from the version
 * being edited and threaded through the workflow input, so the workflow does
 * NOT re-read the DB to find it — that read would be racy (concurrent
 * append-only version writes) and replay-unsafe (after the user-edit row is
 * written, the selection pointer moves to it). #713/#991.
 */
type PriorMotionDirection = {
  dialogue?: MotionDialogue | null;
  audio?: MotionAudio | null;
};
import type { AspectRatio, ImageSize } from '@/lib/constants/aspect-ratios';
import type {
  CharacterMinimal,
  GeneratedAssetActivity,
  GeneratedAssetInput,
  SequenceElementMinimal,
  SequenceLocationMinimal,
  StyleConfig,
} from '@/lib/db/schema';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import type { Json } from '@/types/database';
import { z } from 'zod';
import type { musicDesignResultSchema } from '../ai/response-schemas';

/**
 * Base workflow context that includes authentication
 * All workflows must include userId and teamId for authorization
 */
export interface UserWorkflowContext {
  userId: string;
  teamId: string;
}

export interface SequenceWorkflowContext extends UserWorkflowContext {
  sequenceId?: string;
}
/**
 * Image generation workflow input
 */
export interface ImageWorkflowInput extends SequenceWorkflowContext {
  prompt: string;
  style?: Json;
  model?: keyof typeof IMAGE_MODELS;
  width?: number;
  height?: number;
  imageSize?: ImageSize;
  numImages?: number;
  seed?: number;
  shotId?: string; // Optional: update shot thumbnail
  /** Reference images for character consistency (auto-switches to edit endpoint) */
  referenceImages?: ReferenceImageDescription[];
  /** Skip R2 upload and store fal.ai CDN URL directly (for ephemeral preview images) */
  skipStorage?: boolean;
  /**
   * Per-scene snapshot for divergence detection. When present, the workflow
   * re-resolves character/location/element sheet hashes at write time and
   * routes divergent results into `shot_variants` instead of overwriting
   * the primary thumbnail. Optional: omit for callers that handle their own
   * divergence (e.g. `regenerateShotsWorkflow`) or for preview-mode runs.
   */
  sceneSnapshot?: ShotImageSceneSnapshot;
  /**
   * Aspect ratio frozen at trigger time. Required when `sceneSnapshot` is
   * present so write-time hash recomputation matches the trigger-time hash.
   */
  aspectRatio?: AspectRatio;
  /** Hash over `(prompt, model, aspectRatio, sceneSnapshot)`; validated at start. */
  snapshotInputHash?: string;
  /**
   * `true` when `prompt` came from a user edit (typed in the UI). `false` for
   * auto paths (storyboard generation, smart-retry, preview, scene split)
   * where `prompt` came from `frame.imagePrompt` and would not match a bare
   * edit. Drives whether the workflow appends a `user-edit` variant row.
   */
  userEditedPrompt?: boolean;
  /**
   * Variant-only mode (#547). When true, the run NEVER touches the live primary
   * `shots.*` image/video columns — it writes only this model's
   * `shot_variants` row. (See `persistImageResult`'s `variantOnly` branch and
   * the workflow's set-generating/onFailure guards for the authoritative set of
   * skipped columns.) Used by "add a model to an existing sequence" so a new
   * model lands as a selectable alternate without repointing the primary,
   * tripping staleness, or invalidating the shot's video. Promotion to primary
   * happens later via an explicit "Set". Skips divergence detection entirely
   * (there is no primary to protect).
   */
  variantOnly?: boolean;
}

/**
 * Shot variant generation workflow input — produces the 3x3 shot grid that
 * gets stored in `shot_variants.shotVariantUrl` for the matching primary row.
 */
export interface ShotVariantWorkflowInput extends SequenceWorkflowContext {
  thumbnailUrl: string;
  model?: keyof typeof IMAGE_MODELS;
  imageSize?: ImageSize;
  numImages?: number;
  seed?: number;
  shotId?: string;
  /** Sequence aspect ratio — drives shot grid layout */
  aspectRatio?: AspectRatio;
  /** Scene visual prompt, from the anchor `frame.imagePrompt` mirror (#713) */
  scenePrompt?: string;
  /** Character reference sheets for visual consistency */
  characterReferences?: ReferenceImageDescription[];
  /** Location reference images for environment consistency */
  locationReferences?: ReferenceImageDescription[];
  /** Element reference images (uploaded logos/products) for identity consistency */
  elementReferences?: ReferenceImageDescription[];
}

export interface ShotVariantWorkflowResult {
  variantImageUrl: string;
}

/**
 * Storyboard generation workflow input
 */
export interface StoryboardWorkflowInput extends SequenceWorkflowContext {
  options?: {
    shotsPerScene?: number;
    generateThumbnails?: boolean;
    generateDescriptions?: boolean;
    aiProvider?: 'openai' | 'anthropic' | 'openrouter';
    regenerateAll?: boolean;
  };
  /** Multiple image models for variant generation (first is primary) */
  imageModels?: TextToImageModel[];
  /** Multiple video models for variant generation (first is primary) */
  videoModels?: ImageToVideoModel[];
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
  musicModel?: keyof typeof AUDIO_MODELS;
  /** Multiple audio models for variant generation (first is primary) */
  audioModels?: (keyof typeof AUDIO_MODELS)[];
  /** Talent IDs suggested by user for AI-assisted casting */
  suggestedTalentIds?: string[];
  /** Location IDs suggested by user for visual consistency */
  suggestedLocationIds?: string[];
}

/**
 * Analyze scenes workflow input
 */
export interface AnalyzeScriptWorkflowInput extends SequenceWorkflowContext {
  // Required inputs
  script: string;
  aspectRatio: AspectRatio;
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  imageModel: TextToImageModel;
  /** Multiple image models for variant generation (first is primary) */
  imageModels?: TextToImageModel[];
  videoModel?: ImageToVideoModel;
  /** Multiple video models for variant generation (first is primary) */
  videoModels?: ImageToVideoModel[];
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
  musicModel?: keyof typeof AUDIO_MODELS;
  /** Multiple audio models for variant generation (first is primary) */
  audioModels?: (keyof typeof AUDIO_MODELS)[];
  /** Talent IDs suggested by user for AI-assisted casting */
  suggestedTalentIds?: string[];
  /** Location IDs suggested by user for visual consistency */
  suggestedLocationIds?: string[];
}

/**
 * Scene split workflow input
 */
export type SceneSplitWorkflowInput = SequenceWorkflowContext & {
  promptName: string;
  modelId: AnalysisModelId;
  styleConfig: StyleConfig;
  aspectRatio: AspectRatio;
  script: string;
  /** User-uploaded elements to make the model aware of uppercase tokens */
  elements?: SequenceElementMinimal[];
};

export type SceneSplitWorkflowResult = {
  scenes: Scene[];
  title: string;
  shotMapping: ShotMapping;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
};

/**
 * Element sheet workflow input — generates a canonical reference image for
 * each element-bible entry that has no user-uploaded reference (recurring
 * products/objects detected during scene split) and ingests them as
 * `sequence_elements` rows so shot generation can attach them.
 */
export interface ElementSheetWorkflowInput extends UserWorkflowContext {
  sequenceId: string;
  /** Element bible entries with no matching uploaded element */
  entries: ElementBibleEntry[];
  /** Image model to use (defaults to DEFAULT_IMAGE_MODEL) */
  imageModel?: TextToImageModel;
  /** Sequence style config to keep references on-style */
  styleConfig?: StyleConfig;
}

export interface ElementSheetWorkflowResult {
  /** Generated + ingested elements — the run fails if any entry failed */
  elements: SequenceElementMinimal[];
}

/**
 * Motion generation workflow input
 */
export interface MotionWorkflowInput extends SequenceWorkflowContext {
  shotId?: string;
  imageUrl: string;
  prompt: string;
  model?: keyof typeof IMAGE_TO_VIDEO_MODELS;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  aspectRatio?: AspectRatio; // "16:9", "9:16", "1:1"
  /**
   * For audio-capable models (kling v3, veo3), pass `false` to suppress the
   * model's native audio output (sfx/ambient/lip-sync). Omit to use the API
   * schema default (true for audio-capable models).
   */
  generateAudio?: boolean;
  /**
   * `true` when `prompt` came from a user edit (typed in the UI). `false` for
   * auto paths (batch generation, smart-retry) where `prompt` was produced by
   * `resolveMotionPrompt` and may include model-specific dialogue/audio
   * assembly that does not match the bare `shot.motionPrompt`. Drives whether
   * the workflow appends a `user-edit` variant row.
   */
  userEditedPrompt?: boolean;
  /**
   * Only meaningful when `userEditedPrompt`: the dialogue/audio direction of the
   * version being edited, captured at trigger time so the recorded user-edit
   * version carries it forward (audio-capable models still get enrichment after
   * a raw-text edit). Threaded in instead of re-read in-workflow — see
   * {@link PriorMotionDirection}.
   */
  priorMotion?: PriorMotionDirection;
  /**
   * Character + element reference images for identity consistency across the
   * clip (#873). Resolved at trigger time from the scene's continuity tags +
   * the cast/element library. Only consumed by Kling v3 Pro (emitted as its
   * `elements` field); every other model ignores them.
   */
  referenceImages?: ReferenceImageDescription[];
  /**
   * Variant-only mode (#547). When true, the run NEVER touches the legacy
   * `shots.video*` / `motionModel` columns — it writes only this model's
   * `shot_variants` row. Used by "add a video model to an existing sequence"
   * so the new model lands as a selectable alternate without repointing the
   * primary video. Promotion happens later via an explicit "Set".
   */
  variantOnly?: boolean;
}

/**
 * Character sheet generation workflow input
 */
export interface CharacterSheetWorkflowInput extends SequenceWorkflowContext {
  /** sequence_characters.id */
  characterDbId: string;
  /** Character name for logging */
  characterName: string;
  /** Character metadata from script analysis */
  characterMetadata: CharacterBibleEntry;
  /** Image model to use (defaults to nano_banana_2) */
  imageModel?: TextToImageModel;
  /** Reference image URL (e.g., from talent sheet) for recasting */
  referenceImageUrl?: string;
  /** Talent metadata from talent sheet (for appearance overrides when recasting) */
  talentMetadata?: CharacterBibleEntry;
  /** Talent description to include in prompt */
  talentDescription?: string;
  /** Sequence style config to apply to the character sheet */
  styleConfig?: StyleConfig;
  /**
   * Snapshot of the upstream talent sheet's `input_hash` at trigger time.
   * `null` when the character has no talent assignment, or when the talent
   * sheet predates hash tracking. Snapshot pattern only — see
   * docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
   */
  talentSheetInputHash?: string | null;
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash?: string;
}

/**
 * Per-shot snapshot DTO for `regenerateShotsWorkflow`. The hashes are
 * snapshot-time `input_hash` values from the referenced sheets/library rows;
 * `null` means the row predated hash tracking and is treated as
 * "unknown, never stale" rather than forcing a false-positive divergence.
 */
export type RegenerateShotSnapshot = {
  shotId: string;
  /** Visual prompt frozen at trigger time. */
  imagePrompt: string;
  /** Sorted character-sheet input_hashes referenced by this shot. */
  characterSheetHashes: string[];
  /** Sorted location-sheet input_hashes referenced by this shot. */
  locationSheetHashes: string[];
  /** Sorted element reference-image identities referenced by this shot. */
  elementReferenceHashes: string[];
  /** Reference image descriptions used for image generation. */
  characterRefs: ReferenceImageDescription[];
  locationRefs: ReferenceImageDescription[];
  /**
   * Per-shot hash of `(prompt, model, aspect, characterSheetHashes,
   * locationSheetHashes, elementReferenceHashes)`. Stored on the artifact row
   * at write time and compared to a freshly recomputed hash to detect
   * divergence.
   */
  snapshotInputHash: string;
};

/**
 * Regenerate shots workflow input
 * Bulk regenerates shot images after a character or location recast.
 *
 * Carries an inlined snapshot per shot (resolved at trigger time) so the
 * workflow does not read live mutable state inside `context.run`. See
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
 */
/**
 * "Update all" (#1077): regenerate every stale artifact in scope, in
 * dependency order (prompt → image per shot). The payload is deliberately
 * tiny — the workflow's `compute-plan` step recomputes staleness from live
 * scoped state at run start and persists the plan as its durable step result,
 * so the target set is authoritative and immune to a stale client cache.
 */
export interface UpdateStaleShotsWorkflowInput extends SequenceWorkflowContext {
  sequenceId: string;
  /** Limit to one scene's shots (scene-scope Update all). */
  sceneId?: string;
  /** Limit to a single shot (shot-scope Update all). */
  shotId?: string;
}

export interface RegenerateShotsWorkflowInput extends SequenceWorkflowContext {
  /** Shot IDs to regenerate */
  shotIds: string[];
  /**
   * What kind of entity triggered this regeneration. Drives which realtime
   * channel the workflow emits start/complete/failed events on.
   */
  triggerKind: 'character' | 'location';
  /**
   * ID of the row that triggered the recast (character or location). Used
   * only as the realtime channel key on `recast:*` / `recast-location:*`.
   */
  triggerId: string;
  /** Image model to use */
  imageModel?: TextToImageModel;
  /** Aspect ratio (frozen at trigger time, replaces a live sequence read). */
  aspectRatio: AspectRatio;
  /** Per-shot inlined snapshot DTOs. */
  shotSnapshots: RegenerateShotSnapshot[];
  /**
   * Hash over the full inlined DTO. The workflow validates this against a
   * recompute at start (tamper check) via `createScopedWorkflow`'s snapshot
   * extension.
   */
  snapshotInputHash: string;
}

/**
 * Recast character workflow input
 * Orchestrates character sheet generation + shot regeneration for recast
 */
export interface RecastCharacterWorkflowInput extends SequenceWorkflowContext {
  /** Character database ID */
  characterDbId: string;
  /** Character name for logging */
  characterName: string;
  /** Character metadata from script analysis */
  characterMetadata: CharacterBibleEntry;
  /** Image model to use */
  imageModel?: TextToImageModel;
  /** Reference image URL from talent sheet */
  referenceImageUrl?: string;
  /** Talent metadata for appearance overrides */
  talentMetadata?: CharacterBibleEntry;
  /** Talent description */
  talentDescription?: string;
  /** Shot IDs to regenerate after sheet generation */
  affectedShotIds: string[];
  /** Sequence style config to apply to the character sheet */
  styleConfig?: StyleConfig;
}

/**
 * Talent-to-character match result from AI casting
 */
export type TalentCharacterMatch = {
  /** Character ID from CharacterBibleEntry.characterId */
  characterId: string;
  /** Talent database ID */
  talentId: string;
  /** Talent name for logging/display */
  talentName: string;
  /** Talent's default sheet image URL for reference */
  sheetImageUrl: string;
  /** Talent sheet metadata for appearance blending */
  sheetMetadata?: CharacterBibleEntry;
};

/**
 * Talent matching workflow input
 */
export interface TalentMatchingWorkflowInput extends SequenceWorkflowContext {
  analysisModelId: AnalysisModelId;
  suggestedTalentIds?: string[];
  /** Pre-extracted character bible from scene splitting. Skips extraction LLM call when provided. */
  characterBible: CharacterBibleEntry[];
}

export interface TalentMatchingWorkflowOutput {
  matches: TalentCharacterMatch[];
}

/**
 * Character sheet generation workflow input
 */
export interface CharacterBibleWorkflowInput extends SequenceWorkflowContext {
  // Character bible from script analysis
  characterBible: CharacterBibleEntry[];

  /** Image model to use (defaults to nano_banana_2) */
  imageModel?: TextToImageModel;

  /** Matched talent data for characters that should use talent references */
  talentMatches?: TalentCharacterMatch[];

  /** Sequence style config to apply to character sheets */
  styleConfig?: StyleConfig;
}

/**
 * Maps each analysis scene (the LLM-assigned `Scene.sceneId` string carried in
 * the analysis output) to the DB shot row created for it. `analysisSceneId` is
 * deliberately NOT the new `scenes.id` ULID (see DbSceneId in schema/scenes.ts)
 * — both are strings, so the distinct name guards against confusing them.
 *
 * `frameId` is the shot's anchor frame id, captured at shot-creation time in
 * `scene-split-workflow` (the write already materializes the anchor) and threaded
 * through here so downstream prompt workflows never read it back from the DB
 * (#991: no DB reads in workflows). `null` only for the anonymous/no-persist
 * path where no shots or frames exist.
 */
type ShotMapping = Array<{
  analysisSceneId: string;
  shotId: string;
  frameId: string | null;
}>;

export interface FramePromptBatchWorkflowInput extends SequenceWorkflowContext {
  scenes: Scene[];
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  /** Maps sceneId to shotId for DB persistence after visual prompt generation */
  shotMapping?: ShotMapping;
}

/**
 * Visual prompt workflow result. The generated prompts are persisted to
 * `frame_prompt_versions` by the per-scene child, but are ALSO returned in
 * memory so the parent pipeline (analyze-script) threads them straight to the
 * next phase rather than re-reading the DB mirror — versions are append-only
 * and concurrent runs may have repointed the mirror, so a DB read is racy
 * (#713/#991). Keyed by `sceneId`.
 */
export interface FramePromptBatchWorkflowResult {
  scenes: Scene[];
  visualPromptsBySceneId: Record<string, VisualPrompt>;
}

export interface FramePromptWorkflowInput extends SequenceWorkflowContext {
  scene: Scene;
  sceneBefore?: Scene;
  sceneAfter?: Scene;
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  shotId?: string;
  /**
   * Anchor frame id for `shotId`, resolved by the caller and passed in so the
   * workflow never reads the DB (#991). The visual prompt is persisted ONLY when
   * this is a real id, so it is REQUIRED (not optional): every trigger must
   * consciously resolve it — pass `null` only when the shot genuinely has no
   * anchor frame (the workflow logs + skips persistence). Leaving it off was a
   * silent "prompt never saved" bug, so the compiler now demands it.
   */
  frameId: string | null;
  /**
   * Stream incremental `fullPrompt` deltas over the per-shot realtime
   * channel while the LLM generates. Set by the explicit "Regenerate Prompt"
   * button so the active viewer sees the prompt fill in live; left unset by
   * script-analysis / auto-staleness paths so we don't burn realtime
   * publishes on workflows nobody is watching.
   */
  emitStreaming?: boolean;
}

export interface MotionPromptBatchWorkflowInput extends SequenceWorkflowContext {
  scenes: Scene[];
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  shotMapping?: ShotMapping;
  /**
   * Rendered starting-shot image URL per scene (`sceneId` → primary
   * `thumbnailUrl`), captured at trigger time so the per-scene motion-prompt
   * children never look it up mid-run (#929). Absent / null entry → that scene
   * had no rendered still and falls back to the text-only motion path.
   */
  startingFrameImageUrls?: Record<string, string | null>;
}

export interface MotionPromptWorkflowInput extends SequenceWorkflowContext {
  scene: Scene;
  sceneBefore?: Scene;
  sceneAfter?: Scene;
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  shotId?: string;
  /**
   * Rendered starting-shot image URL, captured at trigger time (#929). The
   * motion prompt is conditioned on this exact still (vision input) and the
   * URL is its staleness identity — it must be PASSED IN, never looked up
   * inside the workflow, so a concurrent re-render can't swap it mid-run. Null
   * / absent → no still available, text-only motion path.
   */
  startingFrameImageUrl?: string | null;
  /** See {@link FramePromptWorkflowInput.emitStreaming}. */
  emitStreaming?: boolean;
}
/**
 * Workflow result types
 */
export interface MotionWorkflowResult {
  videoUrl: string;
  duration?: number;
}

export interface CharacterSheetWorkflowResult {
  sheetImageUrl: string;
  characterDbId?: string;
  sheetImagePath?: string;
}

/**
 * Upscale shot variant workflow input — upscales a cropped shot-grid tile
 * to higher resolution.
 */
export interface UpscaleShotVariantWorkflowInput extends SequenceWorkflowContext {
  shotId: string;
  /** URL of the cropped tile to upscale */
  croppedTileUrl: string;
  /** R2 path of the cropped tile (for replacement) */
  croppedTilePath: string;
  /** Sequence aspect ratio — determines output image size for upscale */
  aspectRatio?: AspectRatio;
  /** Character reference sheets for visual consistency during upscale */
  characterReferences?: ReferenceImageDescription[];
  /** Location reference images for environment consistency during upscale */
  locationReferences?: ReferenceImageDescription[];
  /**
   * The grid-sheet `frame_variants` version the tile was cropped from (#989).
   * Recorded as `frame_variants.sourceVariantId` on the upscaled framing version.
   */
  sourceVariantId?: string | null;
  /**
   * `model` of that grid sheet — the model that generated the tile being
   * upscaled (#1066). The upscale renders on it so the result isn't restyled,
   * and so the version it writes carries the shot's real look model. Falls back
   * to `UPSCALE_FALLBACK_MODEL` when the model has no edit endpoint.
   */
  sourceModel?: string | null;
}

export interface UpscaleShotVariantWorkflowResult {
  upscaledUrl: string;
  upscaledPath: string;
}

/**
 * Library talent sheet generation workflow input
 * Generates a talent sheet from reference media uploaded by the user
 */
export interface LibraryTalentSheetWorkflowInput extends UserWorkflowContext {
  /** Talent ID from the library */
  talentId: string;
  /** Talent name for the prompt */
  talentName: string;
  /** Talent description for the prompt */
  talentDescription?: string;
  /** Reference media URLs to use as input (optional - if not provided, generates from name/description) */
  referenceImageUrls?: string[];
  /** Image model to use */
  imageModel?: TextToImageModel;
  /** Name for the generated sheet */
  sheetName?: string;
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash?: string;
}

export interface LibraryTalentSheetWorkflowResult {
  sheetId: string;
  sheetImageUrl: string;
  sheetImagePath?: string;
  headshotImageUrl?: string;
  headshotImagePath?: string;
}

/**
 * Location sheet generation workflow input
 */
export interface LocationSheetWorkflowInput extends SequenceWorkflowContext {
  /** locations.id */
  locationDbId: string;
  /** Location name for logging */
  locationName: string;
  /** Location metadata from script analysis */
  locationMetadata: LocationBibleEntry;
  /** Image model to use */
  imageModel?: TextToImageModel;
  /** Reference image URL (e.g., from library location) for overrides */
  referenceImageUrl?: string;
  /** Library location description for overrides */
  libraryLocationDescription?: string;
  /** Sequence style config to apply to the location sheet */
  styleConfig?: StyleConfig;
  /**
   * Snapshot of the parent library location's `reference_input_hash` at
   * trigger time. `null` when the sheet has no library-location reference,
   * or when the library row predates hash tracking.
   */
  libraryLocationReferenceHash?: string | null;
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash?: string;
}

export interface LocationSheetWorkflowResult {
  referenceImageUrl: string;
  locationDbId?: string;
  referenceImagePath?: string;
}

/**
 * Library location sheet generation workflow input
 * Generates a 3x3 grid reference sheet from user-uploaded reference images
 */
export interface LibraryLocationSheetWorkflowInput extends UserWorkflowContext {
  /** locations.id */
  locationDbId: string;
  /** Location name for prompt */
  locationName: string;
  /** Location description for prompt */
  locationDescription?: string;
  /** Reference image URLs (user uploads) */
  referenceImageUrls: string[];
  /** Sequence ID (library sequence) for storage path */
  sequenceId: string;
  /** Image model to use */
  imageModel?: TextToImageModel;
}

export interface LibraryLocationSheetWorkflowResult {
  /** Generated sheet image URL */
  sheetImageUrl: string;
  /** Storage path */
  sheetImagePath?: string;
  /** Generated preview image URL */
  previewImageUrl?: string;
  /** Preview storage path */
  previewImagePath?: string;
  /** Location ID */
  locationDbId: string;
}

/**
 * Location bible generation workflow input
 * Generates reference sheets for all locations in a sequence
 */
export interface LocationBibleWorkflowInput extends UserWorkflowContext {
  sequenceId?: string;
  /** Location bible from script analysis */
  locationBible: LocationBibleEntry[];
  /** Image model to use */
  imageModel?: TextToImageModel;
  /** Library location matches for locations that should use library references */
  libraryLocationMatches?: LibraryLocationMatch[];
  /** Sequence style config to apply to location sheets */
  styleConfig?: StyleConfig;
}

/**
 * Library location match result
 */
export type LibraryLocationMatch = {
  /** Location ID from LocationBibleEntry.locationId */
  locationId: string;
  /** Library location database ID */
  libraryLocationId: string;
  /** Library location name */
  libraryLocationName: string;
  /** Library location reference image URL */
  referenceImageUrl: string;
  /** Library location description for prompt enhancement */
  description?: string;
};

/**
 * Location matching workflow input
 */
export interface LocationMatchingWorkflowInput extends SequenceWorkflowContext {
  analysisModelId: AnalysisModelId;
  suggestedLocationIds?: string[];
  /** Pre-extracted location bible from scene splitting. Skips extraction LLM call when provided. */
  locationBible: LocationBibleEntry[];
}

export interface LocationMatchingWorkflowOutput {
  matches: LibraryLocationMatch[];
}
/**
 * Recast location workflow input
 * Orchestrates location sheet generation + shot regeneration for recast
 */
export interface RecastLocationWorkflowInput extends SequenceWorkflowContext {
  /** Location database ID */
  locationDbId: string;
  /** Location name for logging */
  locationName: string;
  /** Location metadata from script analysis */
  locationMetadata: LocationBibleEntry;
  /** Image model to use */
  imageModel?: TextToImageModel;
  /** Reference image URL from library location */
  referenceImageUrl?: string;
  /** Library location description */
  libraryLocationDescription?: string;
  /** Shot IDs to regenerate after sheet generation */
  affectedShotIds: string[];
  /** Sequence style config to apply to the location sheet */
  styleConfig?: StyleConfig;
}

/**
 * Compact scene summary passed to the music workflow for AI prompt generation
 */
export type MusicSceneSummary = {
  sceneId: string;
  title: string;
  storyBeat: string;
  durationSeconds: number;
  location: string;
  timeOfDay: string;
  visualSummary: string;
};

/**
 * Music generation workflow input
 * Generates background music for an entire sequence using musicDesign specs
 */
export interface MusicPromptWorkflowInput extends SequenceWorkflowContext {
  /** Compact scene summaries for AI prompt generation (legacy fallback) */
  sceneSummaries: MusicSceneSummary[];

  analysisModelId: AnalysisModelId;

  duration?: number;
}

export type MusicPromptWorkflowResult = z.infer<typeof musicDesignResultSchema>;
/**
 * Music generation workflow input
 * Generates background music for an entire sequence using musicDesign specs
 */
export interface MusicWorkflowInput extends SequenceWorkflowContext {
  /** Pre-generated prompt. If provided with tags, skip LLM step. */
  prompt: string;
  /** Pre-generated tags. If provided with prompt, skip LLM step. */
  tags: string;
  /** Duration in seconds */
  duration: number;
  /** Audio model to use */
  model?: keyof typeof AUDIO_MODELS;
  /**
   * Whether this model owns the live `sequences.music*` columns (#546). In a
   * multi-model fan-out only the primary (audioModels[0]) writes the shared
   * sequence row + drives `musicStatus`; secondary models persist only their
   * own `sequence_music_variants` row and emit model-scoped events. Defaults
   * to true for single-model / legacy callers that don't set it.
   */
  isPrimary?: boolean;
}

export interface MusicWorkflowResult {
  audioUrl: string;
  duration?: number;
}

/**
 * Batch motion + music workflow input
 * Orchestrates parallel motion generation for all shots + optional music,
 * then merges videos and muxes audio.
 */
export interface BatchMotionMusicWorkflowInput extends SequenceWorkflowContext {
  /** Per-shot motion inputs (ordered by scene) */
  shots: Array<{
    shotId: string;
    imageUrl: string;
    /**
     * Prompt assembled for the primary model. Used directly for single-model
     * runs and as the fallback when `motionPrompt` is absent. For multi-model
     * fan-out, `motion-batch` re-assembles per model from `motionPrompt`.
     */
    prompt: string;
    model?: ImageToVideoModel;
    /**
     * Structured motion prompt (#545). When present, `motion-batch` assembles
     * a model-specific prompt for each model in `videoModels` via
     * `assembleMotionPrompt`. Absent on manual single-model paths, which pass
     * a pre-assembled `prompt` instead. Carries only the assemblable fields
     * (fullPrompt + dialogue/audio) — sourced from the shot's selected motion
     * `shot_prompt_versions` row, not `metadata.prompts.motion` (#713).
     */
    motionPrompt?: AssemblableMotionPrompt;
    /**
     * Scene character tags (`continuity.characterTags`). Passed alongside
     * `motionPrompt` so per-model re-assembly can apply character-only
     * in-prompt guards (e.g. Seedance's "Avoid jitter and bent limbs.").
     */
    characterTags?: string[];
    duration?: number;
    fps?: number;
    motionBucket?: number;
    aspectRatio?: AspectRatio;
    /** See `MotionWorkflowInput.generateAudio`. */
    generateAudio?: boolean;
    /** See `MotionWorkflowInput.userEditedPrompt`. */
    userEditedPrompt?: boolean;
    /** See `MotionWorkflowInput.priorMotion`. */
    priorMotion?: PriorMotionDirection;
    /** See `MotionWorkflowInput.referenceImages` (#873). */
    referenceImages?: ReferenceImageDescription[];
  }>;
  /**
   * Video models to generate for every shot (#545). First is primary (its
   * output also lands in the legacy `shots.video*` columns); the rest are
   * alternates stored only in `shot_variants`. When absent, each shot's own
   * `model` is used (single-model behaviour).
   */
  videoModels?: ImageToVideoModel[];
  /** When true, generate music in parallel and mux into final video */
  includeMusic: boolean;
  /** Music config (required when includeMusic=true) */
  music?: {
    prompt: string;
    tags: string;
    duration: number;
    model?: keyof typeof AUDIO_MODELS;
  };
  /**
   * Audio models to generate for the sequence (#546). First is primary (its
   * track also lands on the live `sequences.music*` columns); the rest are
   * alternates stored as separate primary rows in `sequence_music_variants`
   * keyed by (sequenceId, model). When absent, falls back to `music.model`
   * (single-model behaviour). Each model reuses `music.prompt/tags/duration`.
   */
  audioModels?: (keyof typeof AUDIO_MODELS)[];
  /**
   * Variant-only mode (#547), threaded onto every per-shot motion child. When
   * true, no shot writes its video to the legacy `shots.video*` columns —
   * each model lands only in `shot_variants`. Used by "add a video model to an
   * existing sequence" so it never repoints the primary video.
   */
  variantOnly?: boolean;
}

/**
 * Per-scene snapshot for `shotImagesWorkflow`. Carries the upstream sheet
 * hashes alongside each reference URL so the workflow can validate the
 * payload at start-time and detect divergence at write-time.
 */
export type ShotImageSceneSnapshot = {
  sceneId: string;
  visualPrompt: string;
  characterSheetHashes: string[];
  locationSheetHashes: string[];
  elementReferenceHashes: string[];
};

/**
 * Shot images workflow input
 * Orchestrates shot image generation + automatic variant generation
 */
export interface ShotImagesWorkflowInput extends SequenceWorkflowContext {
  scenesWithVisualPrompts: Scene[];
  charactersWithSheets: CharacterMinimal[];
  locationsWithSheets: SequenceLocationMinimal[];
  /** User-uploaded elements (logos, products) for reference-image consistency */
  elements?: SequenceElementMinimal[];
  shotMapping: ShotMapping;
  imageModel?: TextToImageModel;
  /** Multiple image models for variant generation (first is primary) */
  imageModels?: TextToImageModel[];
  aspectRatio: AspectRatio;
  /**
   * Per-scene snapshot of the upstream sheet hashes for the references that
   * will be inlined into image generation. Resolved at trigger time so the
   * workflow can detect divergence (sheet regenerated mid-flight) without
   * reading mutable state inside `context.run`.
   */
  sceneSnapshots?: ShotImageSceneSnapshot[];
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash?: string;
}

export interface ShotImagesWorkflowResult {
  /**
   * Primary image URL per scene, ALIGNED to the input
   * `scenesWithVisualPrompts` order — a failed scene keeps its slot as
   * `null`. Consumers index this by scene position (analyze-script phase 5),
   * so compacting failures out would silently pair the wrong image with the
   * wrong scene.
   */
  imageUrls: (string | null)[];
}

/**
 * Motion + music prompts workflow input
 * Orchestrates motion prompt generation + music design in parallel
 */
export interface MotionMusicPromptsWorkflowInput extends SequenceWorkflowContext {
  scenesWithVisualPrompts: Scene[];
  shotMapping: ShotMapping;
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  videoModel?: ImageToVideoModel;
  /**
   * Multiple video models for variant generation (first is primary). Only the
   * primary is used here for model-aware duration snapping; the structured
   * motion prompts produced are model-independent and assembled per-model
   * downstream in `motion-batch`.
   */
  videoModels?: ImageToVideoModel[];
  /**
   * Rendered starting-shot image URL per scene (`sceneId` → primary
   * `thumbnailUrl`), captured by analyze-script after shot images render and
   * threaded down to the per-scene motion-prompt children (#929). See
   * {@link MotionPromptBatchWorkflowInput.startingFrameImageUrls}.
   */
  startingFrameImageUrls?: Record<string, string | null>;
  /**
   * Visual prompt text per scene (`sceneId` → `frame.imagePrompt`), used as the
   * music prompt's visual grounding. The structured visual prompt moved off
   * `scene.prompts` to `frame_prompt_versions` (#713), so analyze-script (which
   * loaded the mirror) threads it here rather than via `scene.prompts.visual`.
   */
  visualSummaryBySceneId?: Record<string, string>;
}

export interface MotionMusicPromptsWorkflowResult {
  completeScenes: Scene[];
  /**
   * Generated motion prompts keyed by `sceneId`, returned in memory so
   * analyze-script threads them into the render batch without re-reading the
   * `shot.motionPrompt` mirror / selected-version pointer (racy under concurrent
   * append-only version writes — #713/#991). Persisted to `shot_prompt_versions`
   * by the per-scene child.
   */
  motionPromptsBySceneId: Record<string, MotionPrompt>;
  musicPrompt: string;
  musicTags: string;
}

/**
 * Element vision workflow input
 * Describes a single uploaded element image using a vision LLM
 */
export interface ElementVisionWorkflowInput extends SequenceWorkflowContext {
  elementId: string;
  imageUrl: string;
  filename: string;
}

export interface ElementVisionWorkflowResult {
  elementId: string;
  description: string;
  consistencyTag: string;
  /** Final token after any vision-driven auto-rename. */
  token: string;
}

/**
 * Replace element workflow input
 * Orchestrates element image swap + per-shot image edits for affected shots.
 *
 * Per-shot behaviour: invokes `image-workflow` with the existing shot
 * thumbnail as the PRIMARY SOURCE and the new element image as an ELEMENT REF.
 * The image edit endpoint swaps the element while preserving the rest of the
 * shot — this is by design for elements (vs cast/location which fully
 * regenerate the shot).
 */
export interface ReplaceElementWorkflowInput extends SequenceWorkflowContext {
  /** Always present for this workflow — narrowed from the optional base type. */
  sequenceId: string;
  elementId: string;
  /** Token of the element being replaced (for logging + edit prompt) */
  token: string;
  /** Description of the prior element (for the edit prompt; null if vision never ran) */
  previousDescription: string | null;
  /** New image URL (already uploaded to R2 and persisted on the element row) */
  newImageUrl: string;
  /** Original filename of the new image (for vision analysis context) */
  newFilename: string;
  /** Shot IDs to edit using the new element */
  affectedShotIds: string[];
  /**
   * Per-shot motion prompt (sceneId/shotId → resolved + model-assembled string)
   * for the video re-render, resolved by the CALLER before the workflow starts
   * and passed in. Workflows must not read the DB (reads are racy under
   * append-only versioning + non-deterministic on replay — #713/#991); the
   * caller resolves from the selected `shot_prompt_versions` row up front.
   */
  motionPromptByShotId: Record<string, string>;
  /** Image model to use for the edit (defaults to nano_banana_2 for edit support) */
  imageModel?: TextToImageModel;
}

export interface ReplaceElementWorkflowResult {
  elementId: string;
  successCount: number;
  failedCount: number;
}

/**
 * Asset generation workflow input (#458 — direct model access). Everything the
 * run needs is resolved by `createGeneratedAssetFn` and passed here: the
 * workflow only WRITES the `generated_assets` row (plus the house exception of
 * BYOK key resolution via `scopedDb.apiKeys`).
 */
export interface AssetGenerationWorkflowInput extends UserWorkflowContext {
  /** The reserved `generated_assets` row this run fills in. */
  assetId: string;
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev`. */
  endpointId: string;
  activity: GeneratedAssetActivity;
  /** Schema-validated endpoint input, forwarded verbatim to fal. */
  input: GeneratedAssetInput;
}

/**
 * Worker env — generated by `bun cf:typegen` (`wrangler types`) into the
 * COMMITTED `worker-configuration.d.ts` (Cloudflare's recommendation for
 * CI), which declares the runtime types (`WorkflowEntrypoint`,
 * `WorkflowStep`, `WorkflowEvent`, `Workflow`, `WorkflowInstance`) and
 * `Cloudflare.Env` globally. `bun dev` (via the Cloudflare vite plugin)
 * regenerates it automatically; after a `wrangler.jsonc` change, commit the
 * regenerated file. Note the var (non-binding) entries come from
 * `.env.local` at generation time, so regenerate on a machine with a
 * complete env file (`bun setup`).
 *
 * Every workflow binding is typed precisely (payload derived from each
 * entrypoint's `run` signature), so `this.env.X_WORKFLOW` needs no cast and
 * a binding missing from `wrangler.jsonc` fails typecheck at the access
 * site. The remaining runtime guard (deploy-time config drift) lives in
 * `spawnAndAwaitChild`.
 */
export type CloudflareEnv = Cloudflare.Env;
