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
}

/**
 * Variant image generation workflow input
 */
export interface VariantWorkflowInput extends SequenceWorkflowContext {
  thumbnailUrl: string;
  model?: keyof typeof IMAGE_MODELS;
  imageSize?: ImageSize;
  numImages?: number;
  seed?: number;
  frameId?: string;
  /** Sequence aspect ratio — drives variant grid layout */
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

export interface VariantWorkflowResult {
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
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
  musicModel?: keyof typeof AUDIO_MODELS;
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
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
  musicModel?: keyof typeof AUDIO_MODELS;
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
 * Bulk regenerates images for frames containing specific characters after recast.
 *
 * Carries an inlined snapshot per frame (resolved at trigger time) so the
 * workflow does not read live mutable state inside `context.run`. See
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
 */
export interface RegenerateFramesWorkflowInput extends SequenceWorkflowContext {
  /** Frame IDs to regenerate */
  frameIds: string[];
  /** Character ID that triggered regeneration (for logging/tracking) */
  triggeringCharacterId: string;
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
}

export interface MotionPromptWorkflowInput extends SequenceWorkflowContext {
  scenes: Scene[];
  aspectRatio: AspectRatio;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
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
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  frameId?: string;
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
 * Upscale variant workflow input
 * Upscales a cropped variant tile to higher resolution
 */
export interface UpscaleVariantWorkflowInput extends SequenceWorkflowContext {
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

export interface UpscaleVariantWorkflowResult {
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
}

export interface LibraryTalentSheetWorkflowResult {
  sheetId: string;
  sheetImageUrl: string;
  sheetImagePath?: string;
  headshotImageUrl?: string;
  headshotImagePath?: string;
}

/**
 * Merge video workflow input
 * Stitches all frame videos into a single merged video
 */
export interface MergeVideoWorkflowInput extends SequenceWorkflowContext {
  /** Ordered list of video URLs to merge */
  videoUrls: string[];
  /** Target FPS for output (1-60, defaults to lowest of inputs) */
  targetFps?: number;
  /** Target resolution (512-2048 per dimension) */
  resolution?: { width: number; height: number };
}

export interface MergeVideoWorkflowResult {
  mergedVideoUrl: string;
  mergedVideoPath: string | null;
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
 * Merge audio+video workflow input
 * Muxes a music track onto the merged video to produce the final output
 */
export interface MergeAudioVideoWorkflowInput extends SequenceWorkflowContext {
  /** URL of the merged video (all frames stitched) */
  mergedVideoUrl: string;
  /** URL of the sequence-level music track */
  musicUrl: string;
  /** Total duration in milliseconds (for compose track timing) */
  durationMs?: number;
}

export interface MergeAudioVideoWorkflowResult {
  mergedVideoUrl: string;
  mergedVideoPath: string | null;
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
    prompt: string;
    model?: ImageToVideoModel;
    duration?: number;
    fps?: number;
    motionBucket?: number;
    aspectRatio?: AspectRatio;
  }>;
  /** When true, generate music in parallel and mux into final video */
  includeMusic: boolean;
  /** Music config (required when includeMusic=true) */
  music?: {
    prompt: string;
    tags: string;
    duration: number;
    model?: keyof typeof AUDIO_MODELS;
  };
}

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
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
  videoModel?: ImageToVideoModel;
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
}
