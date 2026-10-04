/**
 * Payload and result types for the Cloudflare Workflows entrypoints.
 */

import type { VoiceProvider } from '@/cast/seed-voice';
import type { AspectRatio, ImageSize } from '@/models/aspect-ratios';
import type {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  ImageToVideoModel,
  TextToImageModel,
} from '@/models/models';
import type { AnalysisModelId } from '@/models/models.config';
import type { Resolution } from '@/models/resolutions';
import type { VoicedDialogueLine } from '@/motion/dialogue-tts';
import type {
  CharacterMinimal,
  GeneratedAssetActivity,
  GeneratedAssetInput,
  MotionAudioClip,
  SequenceElementMinimal,
  SequenceLocationMinimal,
  StyleConfig,
} from '@/platform/server/db/schema';
import type { ShotDialogueLine } from '@/platform/server/db/schema/shot-dialogue-versions';
import type { VideoManifest } from '@/platform/server/db/schema/video-variants';
import type { GenerationStage } from '@/sequences/pipeline';
import type { musicDesignResultSchema } from '@/sequences/response-schemas';
import type {
  CharacterSheetInputHash,
  LibraryLocationReferenceInputHash,
  LocationSheetInputHash,
  ShotImageInputHash,
  TalentSheetInputHash,
} from '@/shots/input-hash';
import type {
  DialogueTakeBase,
  DialogueTakeLine,
} from '@/motion/server/record-dialogue-take';
import type {
  AssemblableMotionPrompt,
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  MotionAudio,
  MotionDialogue,
  MotionPrompt,
  Scene,
} from '@/shots/scene-analysis.schema';
import type { UpdateStalePlan } from '@/shots/server/update-stale-plan';
import type { SceneVoicedLine } from '@/shots/shot-dialogue';
import type { StoredShotSpec } from '@/shots/shot-list.schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';
import type { StudioCreateInput } from '@/studio/schema';
import { z } from 'zod';

/**
 * The upstream state a user-edited prompt was authored against, captured at
 * trigger time: derived later it would hash whatever the DB says at
 * execution (or at retry), stamping the edit with inputs the user never saw and
 * leaving staleness permanently reading fresh.
 *
 * `inputHash` is null when the hash could not be computed (no scene, or the
 * context load failed) — the edit is still recorded, just without provenance.
 */
export type UserEditProvenance = {
  inputHash: string | null;
  analysisModel: string | null;
};

/**
 * Before #1786 the RUN wrote the user's edit, so its payload carried it. A run
 * queued before that deploy still carries these fields and nothing else holds
 * the typed prompt, so the run writes the edit as it used to. New triggers
 * write the edit at the click and never set them. Drop once no pre-#1786 run
 * can still be in flight.
 */
type PreClickEditPayload = {
  userEditProvenance?: UserEditProvenance;
  userEditText?: string;
  priorMotion?: { audio?: MotionAudio | null };
};

/**
 * Base workflow context that includes authentication
 * All workflows must include userId and teamId for authorization
 */
export interface UserWorkflowContext {
  userId: string;
  teamId: string;
  /**
   * Run envelope (#1310). Optional so in-flight instances without it still
   * last-resort deduct. Children inherit this from the parent payload.
   */
  reservationId?: string;
  /**
   * This instance created a private envelope (add-model per shot, smart-retry
   * leaf). The base class zeros leftover on success and failure. Leave unset
   * on shared-envelope children so the base class does not zero; parents may
   * still zero explicitly.
   */
  ownsReservation?: boolean;
}

export interface SequenceWorkflowContext extends UserWorkflowContext {
  sequenceId?: string;
}
/**
 * Image generation workflow input
 */
export interface ImageWorkflowInput
  extends SequenceWorkflowContext, PreClickEditPayload {
  prompt: string;
  style?: Record<string, unknown> | unknown[];
  model?: keyof typeof IMAGE_MODELS;
  width?: number;
  height?: number;
  imageSize?: ImageSize;
  numImages?: number;
  seed?: number;
  shotId?: string; // Optional: update shot thumbnail
  /**
   * The shot's anchor frame, resolved at trigger time. Frame id ≠ shot id
   * (#989); passing it keeps every step of the run bound to the SAME frame
   * instead of re-resolving the anchor per step.
   *
   * MANDATORY whenever `shotId` is set. There is no `frames.getAnchorByShot`
   * fallback any more (#1067) — a payload with a `shotId` and no `frameId`
   * writes NOTHING back to the frame: the image still generates and bills, and
   * every frame write (status, variant selection, preview url) is skipped.
   * Optional in the type only for shotless ad-hoc runs and for stale in-flight
   * instances spawned by a pre-#1067 build. See #1119.
   */
  frameId?: string;
  /**
   * The `frame_prompt_versions` row `prompt` was read from, snapshotted at the
   * trigger (#1070). Stamped onto the variant this run writes, so selecting the
   * still later restores the prompt text that actually produced it. A live
   * re-read here would pair the still with a prompt it never saw. Absent on
   * un-migrated triggers, which fall back to the frame's current pointer.
   */
  promptVersionId?: string | null;
  /** Reference images for character consistency (auto-switches to edit endpoint) */
  referenceImages?: ReferenceImageDescription[];
  /**
   * Preview path: no prompt-version row and no shot-status flip. Bytes are
   * still uploaded to R2; the provider CDN URL is not kept.
   */
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
  resolution?: Resolution;
  /** Hash over `(prompt, model, aspectRatio, sceneSnapshot)`; validated at start. */
  snapshotInputHash?: ShotImageInputHash;
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
  variantOnly: boolean;
  /**
   * Pre-created pending `frame_variants` claim row to complete in place
   * (#1085). When set, `set-generating-status` transitions THIS row to
   * 'generating' instead of appending a fresh one, and `persist-result`
   * completes it. Absent on legacy paths (variant adds, storyboard, preview),
   * which keep the append-in-workflow behaviour.
   */
  targetVariantId?: string;
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
  /**
   * The shot's anchor frame, resolved at trigger time (frame id ≠ shot id).
   * Optional only because `shot-images` spawns a grid for a scene that matched
   * no shot; such a run has no `shotId` either and writes nothing. Without it
   * the run generates the grid and skips the sheet — it never resolves the
   * anchor itself, which would read a pointer the spawn never saw.
   */
  frameId?: string;
  /** Sequence aspect ratio — drives shot grid layout */
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  /** Scene visual prompt, from the anchor `frame.imagePrompt` mirror (#713) */
  scenePrompt?: string;
  /** The `frame_prompt_versions` row `scenePrompt` was read from, snapshotted
   * at the trigger — stamped on the sheet version for provenance (#1070). */
  promptVersionId?: string | null;
  /** Already ordered still references, frozen by the shared plan executor. */
  referenceImages?: ReferenceImageDescription[];
  /** Character reference sheets for visual consistency */
  characterReferences?: ReferenceImageDescription[];
  /** Location reference images for environment consistency */
  locationReferences?: ReferenceImageDescription[];
  /** Element reference images (uploaded logos/products) for identity consistency */
  elementReferences?: ReferenceImageDescription[];
  /**
   * What a tile picked from this grid is judged by (#712): the prompt and
   * reference-sheet hashes the grid was generated against, snapshotted at the
   * trigger. The run hashes it and stamps the sheet; a picked tile copies that
   * stamp, so it reads stale after a prompt edit like any other still. Null
   * when the trigger had no visual prompt.
   */
  tileHashInput: StillHashInput | null;
}

/** The {@link ShotImageSceneSnapshot} fields a still's input hash covers. */
export type StillHashInput = Pick<
  ShotImageSceneSnapshot,
  | 'visualPrompt'
  | 'characterSheetHashes'
  | 'locationSheetHashes'
  | 'elementReferenceHashes'
>;

export interface ShotVariantWorkflowResult {
  variantImageUrl: string;
}

/**
 * Storyboard generation workflow input.
 *
 * Everything the run fans out to `analyze-script` is snapshotted from the
 * sequence row by `triggerStoryboard` — the workflow never re-derives it. A
 * mid-run re-read would pick up an edit the user made after pressing generate
 * (or, on a step retry, a different one again), fanning out a payload nobody
 * asked for. Call sites build the smaller {@link StoryboardTriggerInput}.
 */
export interface StoryboardWorkflowInput extends SequenceWorkflowContext {
  title: string;
  script: string;
  /** Request country captured at launch; only a fallback for character background. */
  userCountry?: string;
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  /** `sequences.draftMotion` at launch (#1756) — see `MotionWorkflowInput.draft`. */
  draftMotion?: boolean;
  styleConfig: StyleConfig;
  /**
   * Automatic style (#1213): set when the sequence's style is a placeholder
   * bound to it whose recipe has not been derived yet. The poster renders
   * style-free and analyze-script derives the recipe in parallel with
   * scene-split, then uses it for every later phase. Absent once a snapshot
   * exists (retries).
   */
  pendingAutoStyleId?: string;
  analysisModelId: AnalysisModelId;
  imageModel: TextToImageModel;
  videoModel: ImageToVideoModel;
  /**
   * The sequence-element SET the run operates on, pinned at trigger time. The
   * vision-written fields (description/consistencyTag) legitimately arrive
   * late and are read live; which elements exist must not.
   */
  elementIds: string[];
  /**
   * Provenance for the music prompt this run may write, snapshotted from the
   * sequence row by `triggerStoryboard`. Threaded down analyze-script →
   * motion-music-prompts → music-prompt, which has no signal of its own.
   */
  musicPromptSource: 'ai-generated' | 'regenerated';
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
  /**
   * How far this run should go (#1408). Resolved by the launcher, so the
   * workflow never has to fall back to the auto-generate flags — those are
   * derived from it and kept only for legacy readers.
   */
  stopAt: GenerationStage;
  /**
   * A continue (#1818): the generation plan's units up to the stop, frozen
   * at the click as an Update-all plan. The storyboard runs them through
   * `UpdateStaleShotsWorkflow` instead of analyze-script — only the units,
   * inputs read from D1 at the trigger. Requires `resume`.
   */
  plan?: UpdateStalePlan;
  /** Skip poster + shot delete — this run continues an existing pipeline. */
  resume?: boolean;
  musicModel?: keyof typeof AUDIO_MODELS;
  /** Multiple audio models for variant generation (first is primary) */
  audioModels?: (keyof typeof AUDIO_MODELS)[];
  /** Talent IDs suggested by user for AI-assisted casting */
  suggestedTalentIds?: string[];
  /** Location IDs suggested by user for visual consistency */
  suggestedLocationIds?: string[];
  /** @see TalentMatchingWorkflowInput.suggestedTalent — resolved by the launcher. */
  suggestedTalent?: SuggestedTalentSnapshot[];
  /** @see LocationMatchingWorkflowInput.suggestedLocations — resolved by the launcher. */
  suggestedLocations?: SuggestedLocationSnapshot[];
  /**
   * Owner's email at trigger time (#1276). Null when the triggering user has
   * no address on the team — the ready-email step then no-ops.
   */
  ownerEmail?: string | null;
  /** Absolute `/sequences/:id/scenes` URL, snapshotted with the app origin. */
  sequenceUrl: string;
  /**
   * When false, skip the ready email. API-key `/api/v1` callers poll and
   * don't want a mailbox ping. Default (undefined) is send.
   */
  notify?: boolean;
  /**
   * Reference-only mode: render straight to video from the cast / location /
   * element reference sheets, skipping start-frame generation entirely.
   * Snapshotted from `!sequences.generateStartFrames` by the launcher and passed
   * straight through to analyze-script. Required — omitting it defaulted to
   * image-to-video at destructure while verify hashed the live mode (#1616).
   */
  referenceOnly: boolean;
  /**
   * Design a voice per speaking character (#1553). Snapshotted from
   * `sequences.generateVoices` by the launcher; absent on legacy payloads =
   * off.
   */
  generateVoices?: boolean;
  /**
   * The Music switch (`sequences.includeMusic`), snapshotted by the
   * launcher. Off, a run to Music makes no track.
   */
  includeMusic: boolean;
  /**
   * Shot ids the user routed to Grok on leftover packs (sum under the
   * packing model's min). Snap-to-min is the default; this is the
   * stop-and-pick override. Omitted when the leftover dropdown is not
   * used (storyboard / don't-stop generate); those packs snap up to the
   * model min.
   */
  leftoverGrokShotIds?: string[];
}

/**
 * What call sites hand to `triggerStoryboard`. The launcher resolves the
 * snapshotted sequence fields itself, from the same row it reads for the
 * generation mutex.
 */
export type StoryboardTriggerInput = Omit<
  StoryboardWorkflowInput,
  | 'stopAt'
  | 'includeMusic'
  | 'title'
  | 'script'
  | 'userCountry'
  | 'aspectRatio'
  | 'resolution'
  | 'styleConfig'
  | 'analysisModelId'
  | 'imageModel'
  | 'videoModel'
  | 'elementIds'
  | 'musicPromptSource'
  | 'suggestedTalent'
  | 'suggestedLocations'
  | 'ownerEmail'
  | 'sequenceUrl'
  | 'referenceOnly'
> & {
  /** This click's choice; absent, the launcher falls back to the sequence snapshot. */
  stopAt?: GenerationStage;
};

/**
 * Analyze scenes workflow input
 */
export interface AnalyzeScriptWorkflowInput extends SequenceWorkflowContext {
  // Required inputs
  script: string;
  /** @see StoryboardWorkflowInput.userCountry — passed straight through. */
  userCountry?: string;
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  /** `sequences.draftMotion` at launch (#1756) — see `MotionWorkflowInput.draft`. */
  draftMotion?: boolean;
  styleConfig: StyleConfig;
  /** @see StoryboardWorkflowInput.pendingAutoStyleId — derived here, in parallel with scene-split. */
  pendingAutoStyleId?: string;
  analysisModelId: AnalysisModelId;
  imageModel: TextToImageModel;
  /** @see StoryboardWorkflowInput.elementIds — passed straight through. */
  elementIds: string[];
  /** @see StoryboardWorkflowInput.musicPromptSource — passed straight through. */
  musicPromptSource: 'ai-generated' | 'regenerated';
  /** Multiple image models for variant generation (first is primary) */
  imageModels?: TextToImageModel[];
  videoModel?: ImageToVideoModel;
  /** Multiple video models for variant generation (first is primary) */
  videoModels?: ImageToVideoModel[];
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
  stopAt: GenerationStage;
  musicModel?: keyof typeof AUDIO_MODELS;
  /** Multiple audio models for variant generation (first is primary) */
  audioModels?: (keyof typeof AUDIO_MODELS)[];
  /** Talent IDs suggested by user for AI-assisted casting */
  suggestedTalentIds?: string[];
  /** Location IDs suggested by user for visual consistency */
  suggestedLocationIds?: string[];
  /** @see TalentMatchingWorkflowInput.suggestedTalent — passed straight through. */
  suggestedTalent?: SuggestedTalentSnapshot[];
  /** @see LocationMatchingWorkflowInput.suggestedLocations — passed straight through. */
  suggestedLocations?: SuggestedLocationSnapshot[];
  /**
   * Reference-only mode: render straight to video from the cast / location /
   * element reference sheets, skipping start-frame generation entirely. Pinned
   * onto the payload at the trigger from `!sequences.generateStartFrames` like every
   * other generation setting, so a mid-run toggle cannot change what this run
   * is doing. Required — omitting it defaulted to image-to-video at
   * destructure while verify hashed the live mode (#1616).
   */
  referenceOnly: boolean;
  /** @see StoryboardWorkflowInput.generateVoices — passed straight through. */
  generateVoices?: boolean;
  /** @see StoryboardWorkflowInput.includeMusic — passed straight through. */
  includeMusic: boolean;
  /** @see StoryboardWorkflowInput.leftoverGrokShotIds — passed straight through. */
  leftoverGrokShotIds?: string[];
}

/**
 * Scene split workflow input
 */
export type SceneSplitWorkflowInput = SequenceWorkflowContext & {
  promptName: string;
  modelId: AnalysisModelId;
  aspectRatio: AspectRatio;
  script: string;
  /** @see StoryboardWorkflowInput.userCountry — passed straight through. */
  userCountry?: string;
  /** User-uploaded elements to make the model aware of uppercase tokens */
  elements?: SequenceElementMinimal[];
  /**
   * Clip grid for the shot-list pass (#1593): caps how many shots a scene's
   * label can hold and spreads the label over them. Absent → no cap, an even
   * integer split.
   */
  videoModel?: ImageToVideoModel;
  /**
   * Director recipe for the shot-list pass (camera / pace / coverage).
   * Snapshotted from analyze-script's input — auto-style's derived recipe
   * lands in parallel and is not awaited here, so a first auto run uses the
   * placeholder; a picked library style is the real director.
   */
  styleConfig?: StyleConfig;
};

export type SceneSplitWorkflowResult = {
  scenes: Scene[];
  title: string;
  shotMapping: ShotMapping;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
  /**
   * The `shot_dialogue_versions` row seeded (or already selected) for each
   * shot with lines (#1657), so a fresh run's speeches can name the version
   * they spoke instead of only a continue's.
   */
  dialogueVersionIdByShotId: Record<string, string>;
};

/**
 * Element sheet workflow input — generates a canonical reference image for
 * each element-bible entry that has no user-uploaded reference (recurring
 * products/objects detected during scene split) and ingests them as
 * `sequence_elements` rows so shot generation can attach them.
 */
/**
 * One auto-generated element reference. `elementId` is the `sequence_elements`
 * row id allocated at the spawn: the child's idempotency guards key on it so a
 * replay can't double-bill because the token was renamed since the first
 * attempt (`ElementBibleEntry` carries no id, and the token is renameable by
 * both the user and the vision auto-rename).
 */
export type ElementSheetEntry = ElementBibleEntry & {
  elementId: string;
};

export interface ElementSheetWorkflowInput extends UserWorkflowContext {
  sequenceId: string;
  /** Element bible entries with no matching uploaded element */
  entries: ElementSheetEntry[];
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
 * Per-SCENE Text to Dialogue in the `dialogue` stage, after images and before
 * motion (#1554, #1657). The
 * scene's conversation is recorded whole so every turn is acted in context,
 * but only the shots whose clip no longer matches their lines adopt the new
 * audio — each as a section of the speech, cut to a file and persisted on
 * `shots.audioClips` so motion only attaches it.
 */
export interface DialogueAudioSceneJob {
  /** The scene's voiced turns in speaking order (shot order, then line order). */
  voiced: SceneVoicedLine[];
  /** shot id → the shot_dialogue_versions row its lines came from (absent = derived from the script). */
  dialogueVersionIdByShotId: Record<string, string>;
  /**
   * Each shot's clip length, keyed by shot id (#1651). What a rewrite aims
   * at, so a reading fits the cut rather than stretching it to the cap.
   */
  shotSeconds: Record<string, number>;
  /**
   * Shots that adopt the new audio even though their clip still matches —
   * the user asked for another reading ("Regenerate dialogue"). Empty everywhere else.
   */
  forceAdoptShotIds: string[];
}

export interface DialogueAudioWorkflowInput extends UserWorkflowContext {
  sequenceId: string;
  scenes: DialogueAudioSceneJob[];
  /** Provider per-file floor (H3 Max 2s). Short sections are padded. */
  minDurationSeconds?: number;
  /**
   * Longest clip every selected model can carry (`dialogueAudioMaxSeconds`,
   * #1651). REQUIRED: a default here would be a silent cap, and an absent one
   * is how a 16s section reached a provider that rejects anything over 15.
   */
  maxDurationSeconds: number;
  /** Model that rewrites an over-long section. Defaults to the analysis default. */
  analysisModelId?: AnalysisModelId;
}

/**
 * One line performed at the mic, in the speaker's voice (#1802). Everything
 * the run needs is snapshotted here: the line, the key of the shot's lines,
 * and the shot's current reading the line is spliced into (null: the shot
 * has one voiced line and no current reading that matches its lines, so the
 * take is the whole recording).
 */
export interface DialogueTakeWorkflowInput extends UserWorkflowContext {
  sequenceId: string;
  shotId: string;
  /** `<bucket>/<path>` of the user's take (a PCM WAV). */
  takeStorageKey: string;
  line: DialogueTakeLine;
  /** `dialogueClipSourceKey` of the shot's AUTHORED voiced lines. */
  sourceKey: string;
  /** The `shot_dialogue_versions` row spoken; null when derived. */
  dialogueVersionId: string | null;
  base:
    | (DialogueTakeBase & {
        spokenLines: { index: number; text: string }[] | null;
      })
    | null;
  /** Provider per-file floor (H3 Max 2s). */
  minDurationSeconds: number;
  /** Longest clip the sequence's model carries (`dialogueAudioMaxSeconds`). */
  maxDurationSeconds: number;
}

export interface DialogueAudioWorkflowResult {
  clipsByShotId: Record<string, MotionAudioClip[]>;
}

/**
 * Motion generation workflow input
 */
export interface MotionWorkflowInput
  extends SequenceWorkflowContext, PreClickEditPayload {
  shotId?: string;
  /**
   * The shot's scene, pinned at the trigger. Storyboard pins the analysis
   * ULID (packing key); Generate pins live `scenes.id`. `render_segments.sceneId`
   * must be the live FK — see MotionWorkflow's ensureForShots comment.
   * Optional only until every trigger threads it — absent falls back to
   * reading the shot.
   */
  sceneId?: string | null;
  /**
   * The motion prompt version this clip renders from, recorded in the render
   * manifest. Pinned at the trigger because the workflow cannot re-read it: the
   * selection can move while the run renders. A user edit
   * is written by the trigger at the click (#1786) and this is its id. Absent
   * falls back to the live selection.
   */
  motionPromptVersionId?: string | null;
  /**
   * The anchor frame's `frame_variants` version that `imageUrl` was resolved
   * from, recorded in the render manifest. Pinned alongside the URL so a
   * concurrent select/upscale can't leave the manifest pointing at a still the
   * clip never rendered from. Absent falls back to the live selection.
   */
  frameVersionId?: string | null;
  /**
   * The rendered start frame. Required except in reference-only mode, where
   * this shot has no still by design and `referenceOnly` is set instead.
   */
  imageUrl?: string;
  /**
   * Reference-only mode: render straight to video from the cast / location /
   * element sheets with no start frame. Forces the reference-to-video route
   * (whose start frame is optional) and leaves `frameVersionId` null in the
   * render manifest — the documented meaning of a null there.
   *
   * Required, not defaulted: a caller that forgot it shipped a payload with
   * neither a still nor the flag, which the batch workflow rejected only after
   * credits were reserved.
   */
  referenceOnly: boolean;
  prompt: string;
  model?: keyof typeof IMAGE_TO_VIDEO_MODELS;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  aspectRatio?: AspectRatio; // "16:9", "9:16", "1:1"
  resolution?: Resolution;
  /**
   * Ark draft mode (#1756): render a 480p preview instead of `resolution`.
   * Snapshotted from `sequences.draftMotion` at the trigger. Honoured only by
   * a model with `supportsDraftMode` on the BytePlus via; the version is
   * stamped '480p' + `draftTaskId`.
   */
  draft?: boolean;
  /**
   * Render the 1080p final of an approved draft (#1756). The run opens a
   * version on the draft's own segment with the draft's manifest (same
   * inputs, same hash), skips still ingest, and submits only the task id —
   * Ark reuses the prompt, assets and seed. `prompt` / `imageUrl` /
   * `referenceImages` are then provenance only, not sent.
   */
  finalFromDraft?: {
    taskId: string;
    renderSegmentId: string;
    manifest: VideoManifest;
  };
  /**
   * For audio-capable models (kling v3, seedance), pass `false` to suppress the
   * model's native audio output (sfx/ambient/lip-sync). Omit to use the API
   * schema default (true for audio-capable models).
   */
  generateAudio?: boolean;
  /**
   * The scene's title, for the stored video's human-readable filename. Passed
   * in rather than read at upload time — a workflow has no reason to reach for
   * scene data, and the name should reflect the scene as it was when the render
   * was requested.
   */
  sceneTitle?: string;
  /**
   * The sequence's title, for the stored video's human-readable filename. Same
   * reasoning as `sceneTitle`; absent falls back to reading the shot's sequence.
   */
  sequenceTitle?: string;
  /**
   * Character + element reference images for identity consistency across the
   * clip (#873). Resolved at trigger time from the scene's continuity tags +
   * the cast/element library. Sent on the wire by every model with a
   * reference-to-video route (`MOTION_REFERENCE_ENDPOINTS`) and by the native
   * xAI / Ark / Google inline vias; the rest substitute the tokens with bible
   * descriptions, so they are never ignored — only carried differently.
   */
  referenceImages?: ReferenceImageDescription[];
  /**
   * Spoken lines for which the upstream dialogue stage generated audio
   * (#1554). Snapshotted with each speaker's `voiceId`; empty / omitted means
   * the shot does not require dialogue audio.
   */
  voicedLines?: VoicedDialogueLine[];
  /**
   * Dialogue clips synthesised before the motion workflow starts (#1554).
   * Required to match `voicedLines` whenever that list is non-empty.
   */
  audioClips?: MotionAudioClip[];
  /**
   * Structured motion prompt so render assembly can bind the resolved audio
   * lines after the clips have been generated upstream. Absent on paths that
   * only pass `prompt`.
   */
  motionPrompt?: AssemblableMotionPrompt;
  /** Scene character tags, for per-model prompt assembly. */
  characterTags?: string[];
  /**
   * Variant-only mode (#547). When true, the run NEVER touches the legacy
   * `shots.video*` / `motionModel` columns — it writes only this model's
   * `shot_variants` row. Used by "add a video model to an existing sequence"
   * so the new model lands as a selectable alternate without repointing the
   * primary video. Promotion happens later via an explicit "Set".
   */
  variantOnly?: boolean;
  /**
   * In-clip multi-shot (#1510). When this generation covers several shots of
   * one scene, these are the members in story order. Shot 1 still anchors
   * i2v (`imageUrl` / `referenceOnly` on this payload). Absent on 1-shot jobs.
   */
  coveredShots?: PackedMotionCoveredShot[];
  /**
   * Scene look for the packed prompt header (environment first, once).
   * Snapshotted at the trigger — the run must not re-read the scene.
   */
  packedScene: PackedMotionSceneHeader;
  /**
   * This shot belongs to a 2+ shot scene. A 1-shot job (Grok, or a tile
   * that did not pack) still prepends the packed environment so lighting /
   * palette / look are not lost when the stored body is framing+action only.
   */
  attachSceneHeader?: boolean;
  /**
   * Kling v3 packed `multi_prompt[]`. When set, submit sends this instead of
   * `prompt`. Re-assembled after dialogue TTS the same way `prompt` is.
   */
  multiPrompt?: Array<{ prompt: string; duration: string }>;
}

/** Scene look stated once at the top of a packed in-clip prompt (#1510). */
type PackedMotionSceneHeader = {
  location?: string | null;
  timeOfDay?: string | null;
  lightingSetup?: string | null;
  colorPalette?: string | null;
  look?: string | null;
};

/** One member of a packed in-clip generation (#1510). */
type PackedMotionCoveredShot = {
  shotId: string;
  duration?: number;
  motionPrompt?: AssemblableMotionPrompt;
  motionPromptVersionId?: string | null;
  frameVersionId?: string | null;
  referenceOnly: boolean;
  audioClips?: MotionAudioClip[];
  voicedLines?: VoicedDialogueLine[];
  prompt?: string;
  characterTags?: string[];
};

/**
 * Character sheet generation workflow input
 */
export interface CharacterSheetWorkflowInput extends SequenceWorkflowContext {
  /** sequence_characters.id */
  characterDbId: string;
  /**
   * The look this sheet draws (#2015) — one run makes one look's sheet. Absent
   * only on a run queued before #2015, whose sheet is the default look's
   * (`sheetLookId`).
   */
  lookId: string;
  /**
   * The `character_look_versions` row the look was read from, snapshotted at
   * the trigger and stamped on the sheet's version row. The claim is taken
   * only while the look still points at it.
   */
  lookVersionId: string;
  /** The look's name, for logs and stale causes. */
  lookName: string;
  /** The look's hair / makeup / injury notes; null when it changes none. */
  lookStyling: string | null;
  /**
   * The cast talent at the snapshot; null when not cast. The claim is taken
   * only while the character is still cast with it.
   */
  talentId: string | null;
  /** Character name for logging */
  characterName: string;
  /**
   * The character's bible at the trigger. `standardClothing` is the LOOK's
   * clothing (#2015), not a field of the bible.
   */
  characterMetadata: CharacterBibleEntry;
  /** Image model to use (defaults to nano_banana_2) */
  imageModel?: TextToImageModel;
  /** Reference image URL (e.g., from talent sheet) for recasting */
  referenceImageUrl?: string;
  /** Talent metadata from talent sheet (for appearance overrides when recasting) */
  talentMetadata?: CharacterBibleEntry;
  /** Talent description to include in prompt */
  talentDescription?: string;
  /**
   * When true, copy `referenceImageUrl` onto the character instead of
   * generating a costumed sheet. Snapshotted at trigger time from
   * `shouldReuseTalentSheet`.
   */
  reuseTalentSheet?: boolean;
  /** Sequence style config to apply to the character sheet */
  styleConfig?: StyleConfig;
  /**
   * Snapshot of the upstream talent sheet's `input_hash` at trigger time.
   * `null` when the character has no talent assignment, or when the talent
   * sheet predates hash tracking. Snapshot pattern only — see
   * docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
   */
  talentSheetInputHash?: string | null;
  /**
   * The cast talent's own `description` (#1785), hashed in place of
   * `talentDescription`, which each path words differently for the prompt.
   * `null` when not cast or blank. Snapshot pattern only.
   */
  castTalentDescription: string | null;
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash: CharacterSheetInputHash;
  /**
   * The sheet claim (#1113): the id this run's version row will carry, taken at the trigger
   * (`characterLooks.claimSheet`). The run lands only while the claim still names it,
   * else it parks as divergent. Absent only on a run queued before #1113,
   * which lands unconditionally.
   */
  sheetVersionId: string;
  /**
   * The bible version `characterMetadata` was read from (#1600), stamped on
   * the sheet's version row so it records what it was made from. Null for a
   * row with no bible version yet, and absent on a run queued before #1600.
   */
  bibleVersionId: string | null;
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
  /**
   * The `frame_prompt_versions` row `imagePrompt` was frozen from. Text alone
   * cannot tell a later reader WHICH version the snapshot pinned once the
   * selection pointer has moved. Null for callers that resolve the prompt
   * without a version row.
   */
  imagePromptVersionId?: string | null;
  /**
   * The shot's anchor frame, resolved when the snapshot was built (frame id ≠
   * shot id). Threaded to the variant spawn so the child writes its sheet to
   * the frame the snapshot was taken against instead of re-resolving the
   * anchor mid-run. Null for callers that build a snapshot purely to hash
   * (staleness checks pass it; it is not part of `snapshotInputHash`).
   */
  frameId?: string | null;
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
  snapshotInputHash: ShotImageInputHash;
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
 * dependency order (prompt → image per shot).
 *
 * The plan — which shots, which artifacts, and therefore what gets billed — is
 * computed by `updateStaleShotsFn` and shipped whole, so the run is bound to
 * the state the user actually clicked on rather than to whatever the sequence
 * looks like whenever a concurrency slot frees up. Scope (`sceneId`/`shotId`)
 * and `depth` are inputs to that computation and don't outlive it.
 *
 * Nothing downstream needs run-start freshness: the spawn-time guards (claim
 * hashes, in-flight checks, the music claim) already
 * absorb drift that happens after plan time, so they absorb the trigger→start
 * gap on the same terms.
 */
export interface UpdateStaleShotsWorkflowInput extends SequenceWorkflowContext {
  /** Fresh handoff announces each phase in order; existing continue keeps its schedule. */
  freshRun?: boolean;
  sequenceId: string;
  /**
   * The frozen regeneration plan. Optional only because an instance queued by
   * the previous build replays with the old payload shape; the workflow fails
   * such a run with a validation error rather than silently doing nothing.
   */
  plan?: UpdateStalePlan;
  /**
   * Run as a storyboard continue (#1818): emit the banner's phase events.
   * Update all runs without the banner.
   */
  announcePhases?: boolean;
  /** @see StoryboardWorkflowInput.leftoverGrokShotIds — a continue passes it through. */
  leftoverGrokShotIds?: string[];
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
  resolution?: Resolution;
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
export interface RecastCharacterWorkflowInput
  extends
    SequenceWorkflowContext,
    Pick<
      CharacterSheetWorkflowInput,
      'lookId' | 'lookVersionId' | 'lookName' | 'lookStyling' | 'talentId'
    > {
  /** Character database ID. The sheet redrawn is its default look's (#2015). */
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
  /**
   * Copy the talent sheet onto the character instead of generating a
   * costumed sheet. Threaded through to the character-sheet child.
   */
  reuseTalentSheet?: boolean;
  /**
   * The upstream talent sheet's `input_hash`, resolved at trigger time. The
   * workflow used to re-derive this two DB reads deep, minutes later — a
   * different talent identity than the one the user recast to.
   */
  talentSheetInputHash: string | null;
  /** The cast talent's own description; see `CharacterSheetWorkflowInput`. */
  castTalentDescription: string | null;
  /** The sheet claim for the child; see `CharacterSheetWorkflowInput`. */
  sheetVersionId: string;
  /** See `CharacterSheetWorkflowInput.bibleVersionId`. */
  bibleVersionId: string | null;
  /** Sequence style config to apply to the character sheet */
  styleConfig?: StyleConfig;
  /** Aspect ratio (frozen at trigger time, replaces a live sequence read). */
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  /**
   * Per-shot regenerate-shots snapshots for the shots this character appears
   * in, resolved at trigger time. The scope of the regeneration IS this list —
   * there is no separate `affectedShotIds`. The recast character's own sheet
   * enters as a sentinel (see `recast-snapshot.ts`) because the awaited child
   * has not generated it yet; the workflow substitutes it in memory.
   */
  shotSnapshots: RegenerateShotSnapshot[];
  /** Batch hash over `shotSnapshots` as sent (payload tamper check). */
  snapshotInputHash: string;
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
  /** Talent library description, snapshotted at match time for reuse checks. */
  talentDescription?: string;
  // Talent performance (#1561) from the trigger-time snapshot; `''` = library
  // has none, use the script's (`||` in buildCastingAttributes, which also
  // tolerates pre-#1561 checkpoints that lack the keys).
  personality: string;
  movement: string;
  // Talent voice (#1553), copied onto the character at cast. `null` = the
  // library has none (pre-#1553 checkpoints lack the keys: `?? null`).
  voiceId: string | null;
  voiceDescription: string | null;
  /**
   * Signed real-person portrait (`talent.isHuman`). Stamps character
   * `isPerson: true` at insert (#1682). Absent on pre-stamp checkpoints.
   */
  hasSignedRelease?: boolean;
  /**
   * The matched default sheet's `input_hash`, so a pipeline character sheet
   * is stamped with the same hash a regenerate would (#1113). Absent on
   * pre-#1113 checkpoints.
   */
  sheetInputHash?: string | null;
};

/**
 * Talent matching workflow input
 */
export interface TalentMatchingWorkflowInput extends SequenceWorkflowContext {
  analysisModelId: AnalysisModelId;
  suggestedTalentIds?: string[];
  /**
   * Name/description/performance per suggested talent, snapshotted at the
   * trigger. The workflow re-reads the talent rows only for `defaultSheet.imageUrl`, which
   * genuinely arrives late (fire-and-forget `/library-talent-sheet`); the
   * casting identity itself must not drift mid-run.
   */
  suggestedTalent?: SuggestedTalentSnapshot[];
  /** Pre-extracted character bible from scene splitting. Skips extraction LLM call when provided. */
  characterBible: CharacterBibleEntry[];
}

/** @see TalentMatchingWorkflowInput.suggestedTalent */
type SuggestedTalentSnapshot = {
  talentId: string;
  name: string;
  description: string | null;
  personality: string;
  movement: string;
  voiceId: string | null;
  voiceDescription: string | null;
};

/** @see LocationMatchingWorkflowInput.suggestedLocations */
type SuggestedLocationSnapshot = {
  locationId: string;
  name: string;
  description: string | null;
};

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

  /**
   * Voice Design (#1553). `generateVoices` is the sequence default snapshotted
   * at the trigger; `speakingCharacterIds` are the bible ids with dialogue
   * lines in the analysed scenes (`speakingCharacterIds()`). A voice child
   * spawns for a speaking character when the upserted row resolves
   * `usesVoice()` true and has no voice yet.
   */
  generateVoices: boolean;
  speakingCharacterIds: string[];
  /** Drafts the voice description when the character has none. */
  analysisModelId: AnalysisModelId;
}

/**
 * One character's voice (#1553, #1765): LLM-draft the description when
 * missing, then Voice Design (previews in R2, the top one saved as a voice)
 * or Seed range reads (each take a voice). Spawned per speaking character by
 * the bible workflow and triggered directly by "Generate voice" on the
 * character card.
 */
export interface CharacterVoiceWorkflowInput extends SequenceWorkflowContext {
  sequenceId: string;
  characterDbId: string;
  characterBible: CharacterBibleEntry;
  /** The stored description; empty = draft one from the bible first. */
  voiceDescription: string;
  analysisModelId: AnalysisModelId;
  /**
   * Which provider makes the voice, chosen when the run is triggered
   * (#1765). The workflow checks `=== 'seed'`, so a run already in flight
   * from before this field existed designs on ElevenLabs.
   */
  voiceProvider: VoiceProvider;
  /** Seed takes to record, 1–`SEED_VOICE_MAX_TAKES`. ElevenLabs ignores it. */
  takes: number;
  /**
   * Generating husk this run completes in place (#1715). Absent on in-flight
   * pre-husk payloads; persist then writes via `updateVoice` and does not
   * release the saved id.
   */
  targetVersionId?: string;
}

export interface CharacterVoiceWorkflowResult {
  voiceId: string | null;
  voiceDescription: string;
}

/**
 * Maps each analysis scene (the server-minted `Scene.sceneId` ULID from
 * scene-split) to the DB shot row created for it. `analysisSceneId` is
 * deliberately NOT the `scenes.id` ULID (see DbSceneId in schema/scenes.ts)
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
  /** 1-based order within the scene. Omitted on pre-#1486 mappings (= 1). */
  shotNumber?: number;
}>;

/**
 * Rewrite shot (#1923). One LLM call refills this shot's stored spec.
 * Everything the call needs is on the payload: the run does not read D1.
 */
export interface ShotSpecRewriteWorkflowInput extends SequenceWorkflowContext {
  shotId: string;
  frameId: string | null;
  /** `shots.pendingSpecVersionId` this run holds. */
  claimId: string;
  visualClaimId: string | null;
  motionClaimId: string | null;
  visualWritten: boolean;
  motionWritten: boolean;
  referenceOnly: boolean;
  scene: Scene;
  /** Other shots in the scene. This shot is not in the list. */
  siblingSpecs: Array<{ shotNumber: number | null; spec: StoredShotSpec }>;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
  styleConfig: StyleConfig;
  aspectRatio: AspectRatio;
  analysisModelId: AnalysisModelId;
  lines: Array<{ character: string; line: string; tone: string }>;
  /**
   * Currency hash of the inputs this rewrite is written FROM, snapshotted
   * at the click. Stamped on the new spec row.
   */
  specInputHash: string;
  currentSpec: StoredShotSpec | null;
  dialogue: MotionDialogue;
  /** Manual regenerate streams completion onto the shot prompt channel. */
  emitStreaming?: boolean;
}

export interface ShotSpecRewriteWorkflowResult {
  specVersionId: string | null;
  visualVersionId: string | null;
  motionVersionId: string | null;
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
  /** The look the sheet is of (#2015). */
  lookId: string;
  sheetImagePath?: string;
  /**
   * The live `character_sheet_variants` row selected on a convergent write.
   * Recast substitutes this into still hashes (version id is the sheet
   * identity). Absent on divergent / first-gen-null-hash paths.
   */
  sheetVersionId?: string | null;
  /**
   * The run diverged: `sheetImageUrl` is a parked variant and the character's
   * PRIMARY sheet is unchanged. Without this a parent cannot tell the two
   * paths apart — both return a URL in the same field — and would cascade
   * work against the old sheet. Optional so existing consumers compile.
   */
  diverged?: boolean;
}

/**
 * Upscale shot variant workflow input — upscales a cropped shot-grid tile
 * to higher resolution.
 */
export interface UpscaleShotVariantWorkflowInput extends SequenceWorkflowContext {
  shotId: string;
  /** The shot's anchor frame, resolved at trigger time (frame id ≠ shot id) —
   * the run never re-resolves it, so every step writes to the same frame. */
  frameId: string;
  /**
   * The prompt version selected when the tile was picked (#1070). Stamped on
   * the upscaled version, which BECOMES the frame's selection — without it a
   * later prompt-restore from this still permanently no-ops.
   */
  promptVersionId: string | null;
  /** URL of the cropped tile to upscale */
  croppedTileUrl: string;
  /** R2 path of the cropped tile (for replacement) */
  croppedTilePath: string;
  /** Sequence aspect ratio — determines output image size for upscale */
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  /** Character reference sheets for visual consistency during upscale */
  characterReferences?: ReferenceImageDescription[];
  /** Location reference images for environment consistency during upscale */
  locationReferences?: ReferenceImageDescription[];
  /**
   * Framing version minted at click (`selectShotVariantFn`) with the cropped
   * tile as its url and `status: 'generating'`. The run completes THIS row
   * rather than appending a second generating version — otherwise a refresh
   * mid-upscale would load a url-less pending-promote and hide the overlay.
   */
  versionId?: string;
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
  /**
   * Existing character/talent sheet the user uploaded. When set, the
   * workflow stores this image as the sheet instead of generating a new
   * 4-panel, then crops the close-up panel as the portrait.
   */
  uploadedSheetUrl?: string;
  /** Appearance metadata extracted from the uploaded sheet, when available. */
  uploadedSheetMetadata?: CharacterBibleEntry;
  /** Hash over the inlined DTO; validated by the snapshot middleware. */
  snapshotInputHash: TalentSheetInputHash;
  /**
   * The sheet claim (#1113): the id of the `talent_sheets` row this run writes, taken at the trigger
   * (`talent.claimSheet`). The run lands only while the claim still names it,
   * else it parks as divergent. Absent only on a run queued before #1113,
   * which lands unconditionally.
   */
  sheetId: string;
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
  snapshotInputHash: LocationSheetInputHash;
  /**
   * The reference claim (#1113): the id this run's version row will carry, taken at the trigger
   * (`sequenceLocations.claimReference`). The run lands only while the claim still names it,
   * else it parks as divergent. Absent only on a run queued before #1113,
   * which lands unconditionally.
   */
  referenceVersionId: string;
  /**
   * The bible version `locationMetadata` was read from (#1600); see
   * `CharacterSheetWorkflowInput.bibleVersionId`.
   */
  bibleVersionId: string | null;
}

export interface LocationSheetWorkflowResult {
  referenceImageUrl: string;
  locationDbId?: string;
  referenceImagePath?: string;
  /** Live `location_sheet_variants` id after a convergent write. */
  sheetVersionId?: string | null;
  /**
   * The run diverged: `referenceImageUrl` is a parked variant and the
   * location's PRIMARY reference is unchanged. @see
   * {@link CharacterSheetWorkflowResult.diverged}
   */
  diverged?: boolean;
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
  /**
   * Hash over the inlined DTO at trigger time. The final reference write is
   * gated on it: if the location was renamed/re-described mid-run the sheet is
   * parked as a divergent variant instead of becoming the live reference.
   */
  snapshotInputHash: LibraryLocationReferenceInputHash;
  /**
   * The reference claim (#1113): the id this run holds until it publishes, taken at the trigger
   * (`locations.claimReference`). The run lands only while the claim still names it,
   * else it parks as divergent. Absent only on a run queued before #1113,
   * which lands unconditionally.
   */
  referenceClaimId: string;
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
  /**
   * The library location's `reference_input_hash`, so a pipeline location
   * sheet is stamped with the same hash a regenerate would (#1113). Absent on
   * pre-#1113 checkpoints.
   */
  referenceInputHash?: string | null;
};

/**
 * Location matching workflow input
 */
export interface LocationMatchingWorkflowInput extends SequenceWorkflowContext {
  analysisModelId: AnalysisModelId;
  suggestedLocationIds?: string[];
  /**
   * Name/description per suggested library location, snapshotted at the
   * trigger. @see TalentMatchingWorkflowInput.suggestedTalent — only
   * `referenceImageUrl` is read live.
   */
  suggestedLocations?: SuggestedLocationSnapshot[];
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
  /** The library location this recast binds the sequence location to. */
  libraryLocationId: string;
  /**
   * That library location's `reference_input_hash`, resolved at trigger time.
   * The workflow used to re-derive it two DB reads deep, minutes later.
   */
  libraryLocationReferenceHash: string | null;
  /** The reference claim for the child; see `LocationSheetWorkflowInput`. */
  referenceVersionId: string;
  /** See `LocationSheetWorkflowInput.bibleVersionId`. */
  bibleVersionId: string | null;
  /** Sequence style config to apply to the location sheet */
  styleConfig?: StyleConfig;
  /** Aspect ratio (frozen at trigger time, replaces a live sequence read). */
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  /**
   * Per-shot regenerate-shots snapshots for the shots this location appears
   * in, resolved at trigger time. The scope of the regeneration IS this list —
   * there is no separate `affectedShotIds`. The recast location's own
   * reference enters as a sentinel (see `recast-snapshot.ts`) because the
   * awaited child has not generated it yet; the workflow substitutes it in
   * memory.
   */
  shotSnapshots: RegenerateShotSnapshot[];
  /** Batch hash over `shotSnapshots` as sent (payload tamper check). */
  snapshotInputHash: string;
}

/**
 * One scene as the music LLM reads it, and as its prompt hash covers it.
 * Built only by `src/audio/server/workflows/music-scene-summaries.ts`, from
 * the scene row and its shots' durations, so the stamp and the verify
 * cannot drift (#1783).
 */
export type MusicSceneSummary = {
  sceneId: string;
  title: string;
  storyBeat: string;
  /** The scene's shot durations, summed. */
  durationSeconds: number;
  location: string;
  timeOfDay: string;
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

  /**
   * Provenance of the version this run will write, snapshotted at the trigger
   * (the caller already knows whether a prompt exists). Optional: spawners
   * that predate it fall back to an in-workflow lookup.
   */
  promptSource?: 'ai-generated' | 'regenerated';

  /**
   * The audio model a failed prompt is recorded against (#1115): with no
   * claim to fail, the failure lands as a failed primary track row, so the
   * sequence reads `failed` rather than silently `pending`. Every trigger
   * sets it; optional only for payloads queued before #1115 deployed.
   */
  musicModel?: string;

  /**
   * The track claim a parent took before this prompt (update-stale's
   * regeneration). A failed prompt fails that row instead of generating one.
   */
  musicVariantId?: string;
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
   * Whether this run's track may take the sequence's pointer (#546, #1115).
   * In a multi-model fan-out only the primary (audioModels[0]) claims it and
   * drives the music status; secondary models open their own row only.
   * Defaults to true for single-model / legacy callers that don't set it.
   */
  isPrimary?: boolean;
  /**
   * The `sequence_music_variants` row the trigger opened with its claim
   * (#1115). Absent when the run opens its own (a pipeline child, or a
   * payload queued before the claim).
   */
  variantId?: string;
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
/**
 * Dialogue to record ONCE PER SCENE before a motion fan-out (#1657). Built at
 * the trigger for every scene with a batch shot whose clip no longer matches
 * its lines (no clip, an edited line, a recast voice). The batch runs
 * `DialogueAudioWorkflow` over it first and hands each child its clip, so N
 * shots of one scene are ONE ElevenLabs call acted as one conversation — not N
 * overlapping windows, each billed in full.
 */
export type BatchDialogueSpeech = {
  scenes: DialogueAudioSceneJob[];
  /** See `DialogueAudioWorkflowInput`. */
  minDurationSeconds?: number;
  maxDurationSeconds: number;
  analysisModelId?: AnalysisModelId;
};

export interface BatchMotionMusicWorkflowInput extends SequenceWorkflowContext {
  /** See {@link BatchDialogueSpeech}. Absent when no shot needs a speech. */
  dialogueSpeech?: BatchDialogueSpeech;
  /**
   * @deprecated The pre-#1913 name of `dialogueSpeech`, on a batch queued
   * before the deploy. `MotionBatchWorkflow` reads it as a fallback.
   */
  // ponytail: delete once no pre-#1913 motion batch can be in flight.
  dialogueRecording?: BatchDialogueSpeech;
  /** Per-shot motion inputs (ordered by scene) */
  shots: Array<{
    shotId: string;
    /** See `MotionWorkflowInput.sceneId`. */
    sceneId?: string | null;
    /** Persisted clip membership — packing keeps this group on regenerate. */
    renderSegmentId?: string | null;
    /** See `MotionWorkflowInput.packedScene`. */
    packedScene: PackedMotionSceneHeader;
    /** See `MotionWorkflowInput.attachSceneHeader`. */
    attachSceneHeader?: boolean;
    /** The start frame. Absent only when `referenceOnly` is set. */
    imageUrl?: string;
    /** See `MotionWorkflowInput.referenceOnly`. Required for the same reason. */
    referenceOnly: boolean;
    /** See `MotionWorkflowInput.frameVersionId`. */
    frameVersionId?: string | null;
    /** See `MotionWorkflowInput.motionPromptVersionId`. */
    motionPromptVersionId?: string | null;
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
     * `buildMotionShotPrompt`. Absent on manual single-model paths, which pass
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
    resolution?: Resolution;
    /** See `MotionWorkflowInput.draft`. */
    draft?: boolean;
    /** See `MotionWorkflowInput.generateAudio`. */
    generateAudio?: boolean;
    /** See `MotionWorkflowInput.sceneTitle`. */
    sceneTitle?: string;
    /** See `MotionWorkflowInput.sequenceTitle`. */
    sequenceTitle?: string;
    /** See `MotionWorkflowInput.referenceImages` (#873). */
    referenceImages?: ReferenceImageDescription[];
    /** See `MotionWorkflowInput.voicedLines`. */
    voicedLines?: VoicedDialogueLine[];
    /** See `MotionWorkflowInput.audioClips`. */
    audioClips?: MotionAudioClip[];
    /** See `MotionWorkflowInput.coveredShots`. */
    coveredShots?: PackedMotionCoveredShot[];
    /** Only a batch queued before #1786; see {@link PreClickEditPayload}. */
    userEditProvenance?: PreClickEditPayload['userEditProvenance'];
    userEditText?: PreClickEditPayload['userEditText'];
    priorMotion?: PreClickEditPayload['priorMotion'];
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
   * track takes the sequence's music pointer through the claim, #1115); the
   * rest land as their own `sequence_music_variants` rows. When absent, falls back to `music.model`
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
  /**
   * Present when the scene has 2+ shots so two snapshots of the same scene
   * don't collide. Omitted on the 1-shot path so the batch hash stays
   * byte-identical to pre-#1486 payloads.
   */
  shotId?: string;
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
  resolution?: Resolution;
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
   * Primary image URL per clip, ALIGNED to `shotWorkItems(scenes, shotMapping)`
   * (scene order, then shotNumber). A 1-shot film is still one slot per scene.
   * A failed clip keeps its slot as `null`.
   */
  imageUrls: (string | null)[];
  /**
   * Primary `frame_variants` version id per clip, ALIGNED to `imageUrls`.
   * Null slot = that clip's image failed. Threaded into the motion-batch
   * payload so the clip's manifest names the still it actually rendered from
   * (#1380). Optional only so an in-flight child from a pre-#1380 build
   * (URLs only) still type-checks at the parent; treat a missing array as
   * all-null.
   */
  frameVersionIds?: (string | null)[];
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
  /**
   * Required (`[]` if the sequence has none). Omitting it defaulted to `[]`
   * at destructure and hashed a different shape than verify (#1616).
   */
  elementBible: ElementBibleEntry[];
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
   * Kept on the payload for runs queued before prompts were derived (#1923).
   * Music does not read it.
   */
  startingFrameImageUrls?: Record<string, string | null>;
  /** @see StoryboardWorkflowInput.musicPromptSource — passed to the music-prompt child. */
  musicPromptSource: 'ai-generated' | 'regenerated';
  /**
   * Whether the sequence renders without start frames. Music does not read
   * it. Required — omitting it defaulted to `false` before the hasher ran
   * (#1616).
   */
  referenceOnly: boolean;
  /** Shot lines snapshotted for a pre-#1923 motion batch. Music does not read them. */
  dialogueLinesByShotId?: Record<string, ShotDialogueLine[]>;
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
  /**
   * Per-clip motion prompts keyed by `shotId`. Extra shots of a multi-shot
   * scene live here; the scene-head is also written so motion-batch can
   * look up either map.
   */
  motionPromptsByShotId?: Record<string, MotionPrompt>;
  /**
   * The `shot_prompt_versions` id each per-scene child left live, keyed by
   * `sceneId`. Analyze-script pins this onto the motion-batch payload so the
   * clip's manifest names the prompt it rendered from (#1380). Null when the
   * child persisted nothing (no shot, or the claim was cancelled). Optional
   * only so an in-flight child from a pre-#1380 build still type-checks;
   * treat a missing map as all-null.
   */
  motionPromptVersionIdsBySceneId?: Record<string, string | null>;
  motionPromptVersionIdsByShotId?: Record<string, string | null>;
  musicPrompt: string;
  musicTags: string;
}

/**
 * Element vision workflow input
 * Describes a single uploaded element image using a vision LLM
 */
export interface ElementVisionWorkflowInput extends SequenceWorkflowContext {
  /** Required here: the vision auto-rename is scoped to the sequence. */
  sequenceId: string;
  elementId: string;
  imageUrl: string;
  filename: string;
  /**
   * The element's token at trigger time. The vision auto-rename is a
   * compare-and-swap against it: a user rename landing while the vision LLM
   * runs makes the swap match zero rows, so the user's name survives and the
   * script-wide cascade is skipped.
   */
  token: string;
}

export interface ElementVisionWorkflowResult {
  elementId: string;
  description: string;
  consistencyTag: string;
  /** Final token after any vision-driven auto-rename. */
  token: string;
}

/**
 * Replace element workflow input.
 *
 * Keep this payload. Replace currently persists + vision and leaves shots
 * stale (#1192). A later "apply to shots" action should reuse this fan-out.
 */
/**
 * Per-shot source state for `replaceElementWorkflow`, frozen at trigger time.
 * The workflow spawns image + motion children that repoint the very selection
 * pointers these fields come from, so a mid-run re-read (or a replay after
 * partial fan-out) would edit an already-edited still a second time.
 */
export type ReplaceElementShotSnapshot = {
  /** The shot's anchor frame; null when the shot has no frame row. */
  frameId: string | null;
  /** Selected still to edit; null when there is nothing to edit. */
  sourceImageUrl: string | null;
  /** Model that produced the selected still — preferred for the edit. */
  sourceModel: string | null;
  /** Whether the shot's render segment had a selected video. */
  hasVideo: boolean;
  durationMs: number | null;
};

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
  /**
   * Per-shot source state (still, model, video presence, duration) resolved by
   * the CALLER, keyed by shotId. Same discipline as `motionPromptByShotId`.
   */
  shotSnapshotByShotId: Record<string, ReplaceElementShotSnapshot>;
  /** Sequence aspect ratio, frozen at trigger time. */
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  /**
   * Video model for the re-render, resolved at trigger time — the SAME value
   * the motion prompts in `motionPromptByShotId` were assembled for.
   */
  videoModel: ImageToVideoModel;
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
 * Images and Videos (#1274). The validated create input rides along whole,
 * so the run never re-reads the row and the `activity` discriminant keeps
 * image/video fields where the types can prove them. Video `duration` is
 * already snapped to the model's accepted seconds.
 */
export interface StudioGenerationWorkflowInput extends UserWorkflowContext {
  assetId: string;
  input: StudioCreateInput;
  /**
   * Render the 1080p final of this Ark draft task (#1756). Set by the server
   * fn, never by the client — a task id names another team's render as
   * easily as this one's. `input` is the draft's input at 1080p; the run
   * skips still ingest and submits only the id.
   */
  finalFromDraftTaskId?: string;
  /**
   * Reference images the likeness ledger cleared as showing no person,
   * snapshotted at the trigger. BytePlus sends these as plain URLs instead
   * of spending a CreateAsset on them (`arkStillsForStudio`, #1674).
   */
  noPersonImages: string[];
}

/**
 * Server-side sequence export (#968). Everything the render needs is resolved
 * by the POST handler that reserves the `sequence_exports` row, so the
 * workflow reads no DB: a shot finishing mid-export can't change the cut
 * half-way through, and a step retry re-renders the same snapshot.
 */
export interface SequenceExportWorkflowInput extends UserWorkflowContext {
  sequenceId: string;
  /** Pre-reserved `sequence_exports` row (status `processing`) to fill in. */
  exportId: string;
  /** R2 key the rendered MP4 is uploaded to. */
  storagePath: string;
  /** The ordered cut. Stored URLs — the workflow absolutizes them. */
  scenes: { orderIndex: number; videoUrl: string }[];
  /** Stored music URL, already gated on `includeMusic`; null when muted. */
  musicUrl: string | null;
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
