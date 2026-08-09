/**
 * Canonical SHA-256 hashing of artifact input DTOs for staleness detection.
 *
 * Each helper accepts the minimal input DTO for one artifact type (never a
 * whole DB row) and returns a hex SHA-256 digest. A stored hash that no longer
 * matches a freshly computed one means the inputs that produced the artifact
 * have changed — the artifact is stale.
 *
 * The existing `simpleHash` in `src/lib/utils/hash.ts` is a 32-bit
 * non-cryptographic hash used for prompt-change detection. It is not
 * collision-resistant and not appropriate for cross-entity dependency
 * tracking, hence this separate module.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "What goes into the hash" for the per-artifact input surface.
 */

/**
 * Recursively rebuild a value with object keys sorted. Arrays are preserved in
 * order — set-like fields are sorted by the per-helper DTO before being passed
 * in, so this layer treats every array as ordered.
 *
 * Throws on values that JSON.stringify would silently elide or coerce
 * (`undefined`, functions, symbols, `NaN`, `±Infinity`) — those would produce
 * hash collisions across semantically distinct inputs. Callers must normalize
 * `undefined` optionals to `null` (or use `trim()` for free-text fields, which
 * coerces nullish to `''`) before passing in.
 */
function canonicalize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === undefined) {
    throw new Error(
      'input-hash: undefined is not hashable; use null explicitly'
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`input-hash: ${typeof value} is not hashable`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`input-hash: non-finite number ${value} is not hashable`);
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('input-hash: circular reference in DTO');
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      out[key] = canonicalize(val, seen);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

export async function sha256Hex(input: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(input));
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(json));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

const trim = (s: string | null | undefined): string => (s ?? '').trim();

/** Sort an unordered set of strings so the hash is order-insensitive. */
const sortedRefs = (refs: readonly string[] | undefined): string[] =>
  [...(refs ?? [])].sort();

type ShotImageHashFields = {
  visualPrompt: string;
  imageModel: string;
  aspectRatio: string;
  size?: string | null;
  seed?: number | null;
  characterSheetHashes: readonly string[];
  locationSheetHashes: readonly string[];
  elementReferenceHashes: readonly string[];
};

type ShotImageHashKind = 'thumbnail' | 'variant-image';

export type ShotImageHashInput = ShotImageHashFields & {
  kind: ShotImageHashKind;
};

export function computeShotImageInputHash(
  input: ShotImageHashInput
): Promise<string> {
  return sha256Hex({
    artifact: `shot:${input.kind}`,
    visualPrompt: trim(input.visualPrompt),
    imageModel: input.imageModel,
    aspectRatio: input.aspectRatio,
    size: input.size ?? null,
    seed: input.seed ?? null,
    characterSheetHashes: sortedRefs(input.characterSheetHashes),
    locationSheetHashes: sortedRefs(input.locationSheetHashes),
    elementReferenceHashes: sortedRefs(input.elementReferenceHashes),
  });
}

/**
 * Source the video was derived from. A `variantHash` references the prior
 * artifact-hash chain (so a stale upstream image cascades); a `url` is used
 * when the source is an external asset with no hashable upstream.
 */
type ShotVideoSourceImage =
  | { kind: 'variantHash'; hash: string }
  | { kind: 'url'; url: string };

export type ShotVideoHashInput = {
  sourceImage: ShotVideoSourceImage;
  motionPrompt: string;
  motionModel: string;
  durationSeconds: number;
  fps?: number | null;
  aspectRatio: string;
};

export function computeShotVideoInputHash(
  input: ShotVideoHashInput
): Promise<string> {
  const sourceImage =
    input.sourceImage.kind === 'variantHash'
      ? { kind: 'variantHash' as const, hash: trim(input.sourceImage.hash) }
      : { kind: 'url' as const, url: trim(input.sourceImage.url) };
  return sha256Hex({
    artifact: 'shot:video',
    sourceImage,
    motionPrompt: trim(input.motionPrompt),
    motionModel: input.motionModel,
    durationSeconds: input.durationSeconds,
    fps: input.fps ?? null,
    aspectRatio: input.aspectRatio,
  });
}

/**
 * Hash a video render's manifest → O(1) staleness for a `video_variants`
 * version. The `VideoManifestEntry` rows ARE the snapshot: each referenced
 * motion-prompt / anchor-frame version id (plus the value-snapshot duration)
 * folds into the hash, so when a shot's selected prompt or frame version
 * changes the render diverges → stale. The manifest is hashed directly (not
 * field-by-field) so a future manifest field automatically participates in
 * staleness instead of silently dropping out (cf. the #767 drift class).
 * Order-sensitive (the manifest is ordered by render position), so entries are
 * NOT sorted.
 */
export function computeVideoManifestInputHash(
  manifest: readonly VideoManifestEntry[],
  model: string
): Promise<string> {
  return sha256Hex({ artifact: 'video:manifest', model, manifest });
}

export type ShotAudioHashInput = {
  musicPrompt: string;
  /** Unordered set of music tags. */
  tags: readonly string[];
  durationSeconds: number;
  audioModel: string;
};

export function computeShotAudioInputHash(
  input: ShotAudioHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'shot:audio',
    musicPrompt: trim(input.musicPrompt),
    tags: sortedRefs(input.tags),
    durationSeconds: input.durationSeconds,
    audioModel: input.audioModel,
  });
}

export type CharacterBibleHashFields = {
  name: string;
  age: string;
  gender?: string | null;
  ethnicity?: string | null;
  physicalDescription?: string | null;
  standardClothing?: string | null;
  distinguishingFeatures?: string | null;
  consistencyTag?: string | null;
};

export type CharacterSheetHashInput = {
  characterBible: CharacterBibleHashFields;
  talentSheetHash?: string | null;
  styleConfigHash: string;
  imageModel: string;
};

export function computeCharacterSheetInputHash(
  input: CharacterSheetHashInput
): Promise<string> {
  const cb = input.characterBible;
  return sha256Hex({
    artifact: 'character:sheet',
    characterBible: {
      name: trim(cb.name),
      age: trim(cb.age),
      gender: trim(cb.gender),
      ethnicity: trim(cb.ethnicity),
      physicalDescription: trim(cb.physicalDescription),
      standardClothing: trim(cb.standardClothing),
      distinguishingFeatures: trim(cb.distinguishingFeatures),
      consistencyTag: trim(cb.consistencyTag),
    },
    talentSheetHash: input.talentSheetHash ?? null,
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  });
}

export type LocationBibleHashFields = {
  name: string;
  description?: string | null;
};

export type LocationSheetHashInput = {
  locationBible: LocationBibleHashFields;
  /** Hash of the parent library location's reference image, if any. */
  libraryLocationReferenceHash?: string | null;
  styleConfigHash: string;
  imageModel: string;
};

export function computeLocationSheetInputHash(
  input: LocationSheetHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'location:sheet',
    locationBible: {
      name: trim(input.locationBible.name),
      description: trim(input.locationBible.description),
    },
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  });
}

export type LibraryLocationReferenceHashInput = {
  locationBible: LocationBibleHashFields;
  styleConfigHash: string;
  imageModel: string;
  /** Unordered set of user-uploaded reference image URLs. */
  referenceMediaHashes?: readonly string[];
};

export function computeLibraryLocationReferenceInputHash(
  input: LibraryLocationReferenceHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'library-location:reference',
    locationBible: {
      name: trim(input.locationBible.name),
      description: trim(input.locationBible.description),
    },
    referenceMediaHashes: sortedRefs(input.referenceMediaHashes),
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  });
}

export type TalentSheetHashInput = {
  talent: {
    name: string;
    description?: string | null;
  };
  /** Unordered set of reference media hashes (talent_media rows). */
  referenceMediaHashes: readonly string[];
  imageModel: string;
};

export function computeTalentSheetInputHash(
  input: TalentSheetHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'talent:sheet',
    talent: {
      name: trim(input.talent.name),
      description: trim(input.talent.description),
    },
    referenceMediaHashes: sortedRefs(input.referenceMediaHashes),
    imageModel: input.imageModel,
  });
}

// ---------------------------------------------------------------------------
// Prompt input hashes
//
// Prompts are themselves AI-generated artifacts. The hash captures only the
// upstream context the LLM was given — scene metadata, style config,
// character / location / element bibles, aspect ratio, and the analysis
// model. The LLM's output (`scene.prompts`, `scene.continuity`) is
// deliberately excluded; including it would make every regeneration produce a
// different hash for identical inputs, since LLM output is non-deterministic.
// ---------------------------------------------------------------------------

import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from './scene-analysis.schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';
import type { StyleConfig, VideoManifestEntry } from '@/lib/db/schema';

export type PromptSceneContextHashInput = {
  /**
   * Scene the prompt is being generated for. `prompts` and `continuity` are
   * stripped before hashing — they are downstream LLM output, not input.
   */
  scene: Scene;
  /** Sequence style config (look/feel knobs that influence prompt phrasing). */
  styleConfig: StyleConfig;
  /** Character bible entries; sorted by `characterId` before hashing. */
  characterBible: readonly CharacterBibleEntry[];
  /** Location bible entries; sorted by `locationId` before hashing. */
  locationBible: readonly LocationBibleEntry[];
  /** Element bible entries; sorted by `token` before hashing. */
  elementBible?: readonly ElementBibleEntry[];
  /** Aspect ratio influences composition guidance in the prompt. */
  aspectRatio: string;
  /** Analysis model id (e.g. `anthropic/claude-haiku-4.5`). */
  analysisModel: string;
  /**
   * URL of the rendered starting-shot image this prompt was conditioned on
   * (`shots.thumbnailUrl`), or null when no image has been rendered yet. Only
   * the MOTION prompt consumes this — motion is now generated with the actual
   * still as a vision input (#929). The stored URL embeds a fresh id per
   * render, so re-rendering the still changes it and re-stales the motion
   * prompt. The visual prompt ignores it (the visual prompt produces the
   * image — it can't depend on it).
   */
  startingFrameImageUrl?: string | null;
};

/**
 * Project a scene down to ONLY the fields that are genuine pre-prompt inputs.
 *
 * This is an allowlist, deliberately — a denylist (strip `prompts`/`continuity`/
 * `durationSeconds`) lets any future downstream field that lands on the scene
 * leak into the hash and falsely flag prompts stale. That class of bug is #767
 * (`durationSeconds` snapped mid-pipeline) one field over: `musicDesign`,
 * `audioDesign`, `sourceImageUrl` are all downstream output and must never be
 * hashed here. `durationSeconds` is excluded for the same #767 reason — it is a
 * video parameter (hashed by `computeShotVideoInputHash`), not a prompt driver.
 */
function sceneInputContext(scene: Scene) {
  return {
    // No `sceneId` and no `sceneNumber`: identity/position is not content.
    // Hashing the id made a prompt stale when a scene was re-analysed under a
    // new id without its text changing; hashing the number (= orderIndex + 1)
    // made a pure scene REORDER flag every moved scene's prompts stale (#1108
    // Phase 1 contract: reorder changes no hash). Position still reaches the
    // LLM via the scene object and the neighbour scenes — a documented,
    // deliberate under-hash (staleness doc §4.2).
    originalScript: scene.originalScript,
    metadata: scene.metadata
      ? {
          title: scene.metadata.title,
          location: scene.metadata.location,
          timeOfDay: scene.metadata.timeOfDay,
          storyBeat: scene.metadata.storyBeat,
        }
      : null,
  };
}

/**
 * Project a bible entry down to the fields that actually drive prompt text.
 * Identity / provenance / image-gen-tag fields (`characterId`, `locationId`,
 * `consistencyTag`, `firstMention`) are handed to the LLM but never shape the
 * prose, so hashing them only manufactures false staleness — e.g. a casting tag
 * rewrite or a re-extracted `firstMention.lineNumber`. See the staleness doc
 * §4.2. The LLM still receives the full entries; only the hash is the projection.
 */
function projectCharacterForPrompt(c: CharacterBibleEntry) {
  return {
    name: trim(c.name),
    age: trim(c.age),
    gender: trim(c.gender),
    ethnicity: trim(c.ethnicity),
    physicalDescription: trim(c.physicalDescription),
    standardClothing: trim(c.standardClothing),
    distinguishingFeatures: trim(c.distinguishingFeatures),
  };
}

function projectLocationForPrompt(l: LocationBibleEntry) {
  return {
    name: trim(l.name),
    type: l.type,
    timeOfDay: trim(l.timeOfDay),
    description: trim(l.description),
    architecturalStyle: trim(l.architecturalStyle),
    keyFeatures: trim(l.keyFeatures),
    colorPalette: trim(l.colorPalette),
    lightingSetup: trim(l.lightingSetup),
    ambiance: trim(l.ambiance),
  };
}

function projectElementForPrompt(e: ElementBibleEntry) {
  return {
    token: trim(e.token),
    description: trim(e.description),
  };
}

/**
 * Bibles are conceptually sets — re-ordering by the LLM or DB readback must
 * not produce a different hash. Sorting by the analysis identity field makes
 * the hash order-insensitive while keeping each row's structure intact.
 */
function sortedBibles(input: PromptSceneContextHashInput) {
  const byKey = <T>(arr: readonly T[], key: (t: T) => string): T[] =>
    [...arr].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return {
    characterBible: byKey(input.characterBible, (c) => c.characterId),
    locationBible: byKey(input.locationBible, (l) => l.locationId),
    elementBible: input.elementBible
      ? byKey(input.elementBible, (e) => e.token)
      : null,
  };
}

/**
 * Bumped when the canonical hashed body shape for prompt-input hashes
 * changes — bumping forces every previously-stored hash to diverge from the
 * freshly-computed one, which would normally surface to users as "stale"
 * banners on unchanged content. The staleness handlers short-circuit when
 * the stored hash is null, so the matching deploy step must null the stored
 * prompt hashes (`frame_prompt_versions.input_hash`,
 * `shot_prompt_versions.input_hash`, `sequences.music_prompt_input_hash`) so
 * legacy rows fall through that safe path ('untracked') until regenerated.
 *
 * v5 (#1108): dropped `sceneNumber` from the scene input surface — a pure
 * scene reorder must not re-stale prompts. Nulling migration:
 * 20260808041000_null_prompt_hashes_for_v5.
 */
const PROMPT_INPUT_HASH_VERSION = 5;

export function computeVisualPromptInputHash(
  input: PromptSceneContextHashInput
): Promise<string> {
  const bibles = sortedBibles(input);
  return sha256Hex({
    artifact: 'shot:visual-prompt',
    hashVersion: PROMPT_INPUT_HASH_VERSION,
    scene: sceneInputContext(input.scene),
    styleConfig: input.styleConfig,
    characterBible: bibles.characterBible.map(projectCharacterForPrompt),
    locationBible: bibles.locationBible.map(projectLocationForPrompt),
    elementBible: bibles.elementBible
      ? bibles.elementBible.map(projectElementForPrompt)
      : null,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
  });
}

export function computeMotionPromptInputHash(
  input: PromptSceneContextHashInput
): Promise<string> {
  const bibles = sortedBibles(input);
  return sha256Hex({
    artifact: 'shot:motion-prompt',
    hashVersion: PROMPT_INPUT_HASH_VERSION,
    scene: sceneInputContext(input.scene),
    styleConfig: input.styleConfig,
    characterBible: bibles.characterBible.map(projectCharacterForPrompt),
    locationBible: bibles.locationBible.map(projectLocationForPrompt),
    elementBible: bibles.elementBible
      ? bibles.elementBible.map(projectElementForPrompt)
      : null,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
    // The rendered still motion is conditioned on (#929). Re-rendering the
    // image yields a new URL, which flips this and re-stales the motion prompt.
    startingFrameImageUrl: trim(input.startingFrameImageUrl),
  });
}

export type MusicPromptInputHashInput = {
  /** Compact scene summaries fed to the music LLM — the actual upstream input. */
  sceneSummaries: readonly MusicSceneSummary[];
  analysisModel: string;
};

export function computeMusicPromptInputHash(
  input: MusicPromptInputHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'sequence:music-prompt',
    hashVersion: PROMPT_INPUT_HASH_VERSION,
    sceneSummaries: input.sceneSummaries,
    analysisModel: trim(input.analysisModel),
  });
}

export type SequenceMusicHashInput = {
  prompt: string;
  /** Tag string (comma-joined, as stored on `sequences.musicTags`). */
  tags: string;
  durationSeconds: number;
  audioModel: string;
};

export function computeSequenceMusicInputHash(
  input: SequenceMusicHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'sequence:music',
    prompt: trim(input.prompt),
    tags: trim(input.tags),
    durationSeconds: input.durationSeconds,
    audioModel: input.audioModel,
  });
}
