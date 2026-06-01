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
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  MotionPrompt,
  Scene,
} from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio, ImageSize } from '@/lib/constants/aspect-ratios';
import type {
  CharacterMinimal,
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
  frameId?: string; // Optional: update frame thumbnail
  /** Reference images for character consistency (auto-switches to edit endpoint) */
  referenceImages?: ReferenceImageDescription[];
  /** Skip R2 upload and store fal.ai CDN URL directly (for ephemeral preview images) */
  skipStorage?: boolean;
  /**
   * Per-scene snapshot for divergence detection. When present, the workflow
   * re-resolves character/location/element sheet hashes at write time and
   * routes divergent results into `frame_variants` instead of overwriting
   * the primary thumbnail. Optional: omit for callers that handle their own
   * divergence (e.g. `regenerateFramesWorkflow`) or for preview-mode runs.
   */
  sceneSnapshot?: FrameImageSceneSnapshot;
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
   * where `prompt` may be reassembled from `frame.metadata.prompts.visual`
   * and would not match the bare `frame.imagePrompt`. Drives whether the
   * workflow appends a `user-edit` variant row.
   */
  userEditedPrompt?: boolean;
}

/**
 * Shot variant generation workflow input — produces the 3x3 shot grid that
 * gets stored in `frame_variants.shotVariantUrl` for the matching primary row.
 */
export interface ShotVariantWorkflowInput extends SequenceWorkflowContext {
  thumbnailUrl: string;
  model?: keyof typeof IMAGE_MODELS;
  imageSize?: ImageSize;
  numImages?: number;
  seed?: number;
  frameId?: string;
  /** Sequence aspect ratio — drives shot grid layout */
  aspectRatio?: AspectRatio;
  /** Scene description from frame.metadata.prompts.visual.fullPrompt */
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
    framesPerScene?: number;
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
  frameMapping: Array<{ sceneId: string; frameId: string }>;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
};

/**
 * Motion generation workflow input
 */
export interface MotionWorkflowInput extends SequenceWorkflowContext {
  frameId?: string;
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
   * assembly that does not match the bare `frame.motionPrompt`. Drives whether
   * the workflow appends a `user-edit` variant row.
   */
  userEditedPrompt?: boolean;
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
 * Per-frame snapshot DTO for `regenerateFramesWorkflow`. The hashes are
 * snapshot-time `input_hash` values from the referenced sheets/library rows;
 * `null` means the row predated hash tracking and is treated as
 * "unknown, never stale" rather than forcing a false-positive divergence.
 */
export type RegenerateFrameSnapshot = {
  frameId: string;
  /** Visual prompt frozen at trigger time. */
  imagePrompt: string;
  /** Sorted character-sheet input_hashes referenced by this frame. */
  characterSheetHashes: string[];
  /** Sorted location-sheet input_hashes referenced by this frame. */
  locationSheetHashes: string[];
  /** Reference image descriptions used for image generation. */
  characterRefs: ReferenceImageDescription[];
  locationRefs: ReferenceImageDescription[];
  /**
   * Per-frame hash of `(prompt, model, aspect, characterSheetHashes,
   * locationSheetHashes)`. Stored on the artifact row at write time and
   * compared to a freshly recomputed hash to detect divergence.
   */
  snapshotInputHash: string;
};

/**
 * Regenerate frames workflow input
 * Bulk regenerates frame images after a character or location recast.
 *
 * Carries an inlined snapshot per frame (resolved at trigger time) so the
 * workflow does not read live mutable state inside `context.run`. See
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
 */
export interface RegenerateFramesWorkflowInput extends SequenceWorkflowContext {
  /** Frame IDs to regenerate */
  frameIds: string[];
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
  /** Per-frame inlined snapshot DTOs. */
  frameSnapshots: RegenerateFrameSnapshot[];
  /**
   * Hash over the full inlined DTO. The workflow validates this against a
   * recompute at start (tamper check) via `createScopedWorkflow`'s snapshot
   * extension.
   */
  snapshotInputHash: string;
}

/**
 * Recast character workflow input
 * Orchestrates character sheet generation + frame regeneration for recast
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
  /** Frame IDs to regenerate after sheet generation */
  affectedFrameIds: string[];
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
 * Result from talent matching service
 */
export type TalentMatchResult = {
  /** Successfully matched talent to characters */
  matches: TalentCharacterMatch[];
  /** Talent IDs that couldn't be matched to any character */
  unusedTalentIds: string[];
  /** Talent names that couldn't be matched (for display) */
  unusedTalentNames: string[];
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

export type FrameMapping = Array<{ sceneId: string; frameId: string }>;

export interface VisualPromptWorkflowInput extends SequenceWorkflowContext {
  scenes: Scene[];
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  /** Maps sceneId to frameId for DB persistence after visual prompt generation */
  frameMapping?: FrameMapping;
}

export interface VisualPromptSceneWorkflowInput extends SequenceWorkflowContext {
  scene: Scene;
  sceneBefore?: Scene;
  sceneAfter?: Scene;
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  frameId?: string;
  /**
   * Stream incremental `fullPrompt` deltas over the per-frame realtime
   * channel while the LLM generates. Set by the explicit "Regenerate Prompt"
   * button so the active viewer sees the prompt fill in live; left unset by
   * script-analysis / auto-staleness paths so we don't burn realtime
   * publishes on workflows nobody is watching.
   */
  emitStreaming?: boolean;
}

export interface MotionPromptWorkflowInput extends SequenceWorkflowContext {
  scenes: Scene[];
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  frameMapping?: FrameMapping;
}

export interface MotionPromptSceneWorkflowInput extends SequenceWorkflowContext {
  scene: Scene;
  sceneBefore?: Scene;
  sceneAfter?: Scene;
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  frameId?: string;
  /** See {@link VisualPromptSceneWorkflowInput.emitStreaming}. */
  emitStreaming?: boolean;
}
/**
 * Workflow result types
 */
export interface ImageWorkflowResult {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
}

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
  frameId: string;
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
 * Regenerate frames workflow input for locations
 * Bulk regenerates images for frames at a specific location after recast
 */
export interface RegenerateLocationFramesWorkflowInput extends SequenceWorkflowContext {
  /** Frame IDs to regenerate */
  frameIds: string[];
  /** Location ID that triggered regeneration (for logging/tracking) */
  triggeringLocationId: string;
  /** Image model to use */
  imageModel?: TextToImageModel;
}

/**
 * Recast location workflow input
 * Orchestrates location sheet generation + frame regeneration for recast
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
  /** Frame IDs to regenerate after sheet generation */
  affectedFrameIds: string[];
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
}

export interface MusicWorkflowResult {
  audioUrl: string;
  duration?: number;
}

/**
 * Batch motion + music workflow input
 * Orchestrates parallel motion generation for all frames + optional music,
 * then merges videos and muxes audio.
 */
export interface BatchMotionMusicWorkflowInput extends SequenceWorkflowContext {
  /** Per-frame motion inputs (ordered by scene) */
  frames: Array<{
    frameId: string;
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
     * a pre-assembled `prompt` instead.
     */
    motionPrompt?: MotionPrompt;
    duration?: number;
    fps?: number;
    motionBucket?: number;
    aspectRatio?: AspectRatio;
    /** See `MotionWorkflowInput.generateAudio`. */
    generateAudio?: boolean;
    /** See `MotionWorkflowInput.userEditedPrompt`. */
    userEditedPrompt?: boolean;
  }>;
  /**
   * Video models to generate for every frame (#545). First is primary (its
   * output also lands in the legacy `frames.video*` columns); the rest are
   * alternates stored only in `frame_variants`. When absent, each frame's own
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
}

/**
 * Per-scene snapshot for `frameImagesWorkflow`. Carries the upstream sheet
 * hashes alongside each reference URL so the workflow can validate the
 * payload at start-time and detect divergence at write-time.
 */
export type FrameImageSceneSnapshot = {
  sceneId: string;
  visualPrompt: string;
  characterSheetHashes: string[];
  locationSheetHashes: string[];
  elementReferenceHashes: string[];
};

/**
 * Frame images workflow input
 * Orchestrates frame image generation + automatic variant generation
 */
export interface FrameImagesWorkflowInput extends SequenceWorkflowContext {
  scenesWithVisualPrompts: Scene[];
  charactersWithSheets: CharacterMinimal[];
  locationsWithSheets: SequenceLocationMinimal[];
  /** User-uploaded elements (logos, products) for reference-image consistency */
  elements?: SequenceElementMinimal[];
  frameMapping: FrameMapping;
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
  sceneSnapshots?: FrameImageSceneSnapshot[];
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash?: string;
}

export interface FrameImagesWorkflowResult {
  imageUrls: string[];
}

/**
 * Motion + music prompts workflow input
 * Orchestrates motion prompt generation + music design in parallel
 */
export interface MotionMusicPromptsWorkflowInput extends SequenceWorkflowContext {
  scenesWithVisualPrompts: Scene[];
  frameMapping: FrameMapping;
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
}

export interface MotionMusicPromptsWorkflowResult {
  completeScenes: Scene[];
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
 * Orchestrates element image swap + per-frame image edits for affected frames.
 *
 * Per-frame behaviour: invokes `image-workflow` with the existing frame
 * thumbnail as the PRIMARY SOURCE and the new element image as an ELEMENT REF.
 * The image edit endpoint swaps the element while preserving the rest of the
 * frame — this is by design for elements (vs cast/location which fully
 * regenerate the frame).
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
  /** Frame IDs to edit using the new element */
  affectedFrameIds: string[];
  /** Image model to use for the edit (defaults to nano_banana_2 for edit support) */
  imageModel?: TextToImageModel;
}

export interface ReplaceElementWorkflowResult {
  elementId: string;
  successCount: number;
  failedCount: number;
}

/**
 * Worker env slice for Cloudflare Workflows.
 *
 * The runtime types (`WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent`,
 * `Workflow`, `WorkflowInstance`) are declared globally by `cloudflare-env.d.ts`
 * via the wrangler runtime-types generator. Each binding below maps to an entry
 * in `wrangler.jsonc` under `workflows[]` and is optional because it only
 * exists in CF-deployed builds — local Node/Vercel runs don't bind workflows.
 */
export type CloudflareEnv = Cloudflare.Env & {
  IMAGE_WORKFLOW?: Workflow<unknown>;
  ELEMENT_VISION_WORKFLOW?: Workflow<unknown>;
  MUSIC_WORKFLOW?: Workflow<unknown>;
  MOTION_WORKFLOW?: Workflow<unknown>;
  MOTION_BATCH_WORKFLOW?: Workflow<unknown>;
  CHARACTER_SHEET_WORKFLOW?: Workflow<unknown>;
  LOCATION_SHEET_WORKFLOW?: Workflow<unknown>;
  LIBRARY_TALENT_SHEET_WORKFLOW?: Workflow<unknown>;
  LIBRARY_LOCATION_SHEET_WORKFLOW?: Workflow<unknown>;
  LOCATION_BIBLE_WORKFLOW?: Workflow<unknown>;
  SHOT_VARIANT_WORKFLOW?: Workflow<unknown>;
  UPSCALE_SHOT_VARIANT_WORKFLOW?: Workflow<unknown>;
  VISUAL_PROMPT_SCENE_WORKFLOW?: Workflow<unknown>;
  MOTION_PROMPT_SCENE_WORKFLOW?: Workflow<unknown>;
  MOTION_PROMPT_WORKFLOW?: Workflow<unknown>;
  MUSIC_PROMPT_WORKFLOW?: Workflow<unknown>;
  MOTION_MUSIC_PROMPTS_WORKFLOW?: Workflow<unknown>;
  RECAST_CHARACTER_WORKFLOW?: Workflow<unknown>;
  RECAST_LOCATION_WORKFLOW?: Workflow<unknown>;
  LOCATION_MATCHING_WORKFLOW?: Workflow<unknown>;
  TALENT_MATCHING_WORKFLOW?: Workflow<unknown>;
  CHARACTER_BIBLE_WORKFLOW?: Workflow<unknown>;
  VISUAL_PROMPT_WORKFLOW?: Workflow<unknown>;
  FRAME_IMAGES_WORKFLOW?: Workflow<unknown>;
  REGENERATE_FRAMES_WORKFLOW?: Workflow<unknown>;
  REPLACE_ELEMENT_WORKFLOW?: Workflow<unknown>;
  STORYBOARD_WORKFLOW?: Workflow<unknown>;
  ANALYZE_SCRIPT_WORKFLOW?: Workflow<unknown>;
  SCENE_SPLIT_WORKFLOW?: Workflow<unknown>;
};
