/**
 * Canonical SHA-256 hashing of artifact input DTOs for staleness detection.
 *
 * Each helper accepts the minimal input DTO for one artifact type (never a
 * whole DB row) and returns a hex SHA-256 digest. A stored hash that no longer
 * matches a freshly computed one means the inputs that produced the artifact
 * have changed — the artifact is stale.
 *
 * The existing `simpleHash` in `src/platform/hash.ts` is a 32-bit
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
): Promise<string | null> {
  // A hash over null/null immediately diverges from a live hash built from
  // the selected still + prompt — that's how storyboard clips were born
  // Stale (#1380). Unknown provenance is a null hash, matching
  // `videoVariants.isStale` for legacy rows (never stale).
  if (
    manifest.length > 0 &&
    manifest.every(
      (entry) =>
        entry.motionPromptVersionId == null && entry.frameVersionId == null
    )
  ) {
    return Promise.resolve(null);
  }
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

function characterSheetHashBody(
  input: CharacterSheetHashInput,
  includeName: boolean
): unknown {
  const cb = input.characterBible;
  return {
    artifact: 'character:sheet',
    characterBible: {
      ...(includeName ? { name: trim(cb.name) } : {}),
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
  };
}

export function computeCharacterSheetInputHash(
  input: CharacterSheetHashInput
): Promise<string> {
  return sha256Hex(characterSheetHashBody(input, false));
}

/** Named-bible digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export function computeCharacterSheetInputHashLegacy(
  input: CharacterSheetHashInput
): Promise<string> {
  return sha256Hex(characterSheetHashBody(input, true));
}

/** Verify: current (nameless) digest or the pre-#1108 digest that hashed `name`. */
export async function characterSheetInputHashMatches(
  stored: string | null,
  input: CharacterSheetHashInput
): Promise<boolean> {
  if (!stored) return false;
  const [current, legacy] = await Promise.all([
    sha256Hex(characterSheetHashBody(input, false)),
    sha256Hex(characterSheetHashBody(input, true)),
  ]);
  return stored === current || stored === legacy;
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

function locationSheetHashBody(
  input: LocationSheetHashInput,
  includeName: boolean
): unknown {
  return {
    artifact: 'location:sheet',
    locationBible: {
      ...(includeName ? { name: trim(input.locationBible.name) } : {}),
      description: trim(input.locationBible.description),
    },
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  };
}

export function computeLocationSheetInputHash(
  input: LocationSheetHashInput
): Promise<string> {
  return sha256Hex(locationSheetHashBody(input, false));
}

export async function locationSheetInputHashMatches(
  stored: string | null,
  input: LocationSheetHashInput
): Promise<boolean> {
  if (!stored) return false;
  const [current, legacy] = await Promise.all([
    sha256Hex(locationSheetHashBody(input, false)),
    sha256Hex(locationSheetHashBody(input, true)),
  ]);
  return stored === current || stored === legacy;
}

export type LibraryLocationReferenceHashInput = {
  locationBible: LocationBibleHashFields;
  styleConfigHash: string;
  imageModel: string;
  /** Unordered set of user-uploaded reference image URLs. */
  referenceMediaHashes?: readonly string[];
};

function libraryLocationReferenceHashBody(
  input: LibraryLocationReferenceHashInput,
  includeName: boolean
): unknown {
  return {
    artifact: 'library-location:reference',
    locationBible: {
      ...(includeName ? { name: trim(input.locationBible.name) } : {}),
      description: trim(input.locationBible.description),
    },
    referenceMediaHashes: sortedRefs(input.referenceMediaHashes),
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  };
}

export function computeLibraryLocationReferenceInputHash(
  input: LibraryLocationReferenceHashInput
): Promise<string> {
  return sha256Hex(libraryLocationReferenceHashBody(input, false));
}

export async function libraryLocationReferenceInputHashMatches(
  stored: string | null,
  input: LibraryLocationReferenceHashInput
): Promise<boolean> {
  if (!stored) return false;
  const [current, legacy] = await Promise.all([
    sha256Hex(libraryLocationReferenceHashBody(input, false)),
    sha256Hex(libraryLocationReferenceHashBody(input, true)),
  ]);
  return stored === current || stored === legacy;
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

function talentSheetHashBody(
  input: TalentSheetHashInput,
  includeName: boolean
): unknown {
  return {
    artifact: 'talent:sheet',
    talent: {
      ...(includeName ? { name: trim(input.talent.name) } : {}),
      description: trim(input.talent.description),
    },
    referenceMediaHashes: sortedRefs(input.referenceMediaHashes),
    imageModel: input.imageModel,
  };
}

export function computeTalentSheetInputHash(
  input: TalentSheetHashInput
): Promise<string> {
  return sha256Hex(talentSheetHashBody(input, false));
}

/** Named-talent digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export function computeTalentSheetInputHashLegacy(
  input: TalentSheetHashInput
): Promise<string> {
  return sha256Hex(talentSheetHashBody(input, true));
}

export async function talentSheetInputHashMatches(
  stored: string | null,
  input: TalentSheetHashInput
): Promise<boolean> {
  if (!stored) return false;
  const [current, legacy] = await Promise.all([
    sha256Hex(talentSheetHashBody(input, false)),
    sha256Hex(talentSheetHashBody(input, true)),
  ]);
  return stored === current || stored === legacy;
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
  DialogueVoiceHashInput,
  VoiceCharacter,
} from '@/motion/dialogue-tts';
import {
  dialogueVoicesForHash,
  dialogueVoicesHashBody,
} from '@/motion/dialogue-tts';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from './scene-analysis.schema';
import type { MusicSceneSummary } from '@/platform/server/workflow/types';
import type {
  StyleConfig,
  VideoManifestEntry,
} from '@/platform/server/db/schema';
import { styleConfigHashBody } from '@/look/style-config';
import { z } from 'zod';

/**
 * Visual-prompt assembler DTO (#1616). Every channel is required so stamp
 * and verify cannot independently omit a field. Empty is spelled `[]`, not
 * omitted — the hash *body* still drops empty motion-only channels
 * (`LEGACY_HASH_UNTIL` 2026-09-28).
 */
export type VisualPromptHashInput = {
  scene: Scene;
  styleConfig: StyleConfig;
  characterBible: readonly CharacterBibleEntry[];
  locationBible: readonly LocationBibleEntry[];
  elementBible: readonly ElementBibleEntry[];
  aspectRatio: string;
  analysisModel: string;
};

/**
 * Motion-prompt assembler DTO. Extends the visual channels with the
 * motion-only ones, all required. `characterVoices: []` is voiceless;
 * the hasher projects dialogue + voices into the shape-stable body.
 */
export type MotionPromptHashInput = VisualPromptHashInput & {
  startingFrameImageUrl: string | null;
  referenceOnly: boolean;
  characterVoices: readonly VoiceCharacter[];
};

export type VisualPromptInputHash = string & {
  readonly __brand: 'VisualPromptInputHash';
};
export type MotionPromptInputHash = string & {
  readonly __brand: 'MotionPromptInputHash';
};

/* oxlint-disable typescript/no-unsafe-type-assertion -- sole brand constructors */
const visualPromptInputHash = (hex: string): VisualPromptInputHash =>
  hex as VisualPromptInputHash;
const motionPromptInputHash = (hex: string): MotionPromptInputHash =>
  hex as MotionPromptInputHash;
/* oxlint-enable typescript/no-unsafe-type-assertion */

const voiceCharacterSchema = z.object({
  name: z.string(),
  voiceId: z.string().nullable().optional(),
  voiceOnly: z.boolean().optional(),
});

/** Any non-null object — Scene / StyleConfig / bible rows are validated by TS. */
const requiredObject = z.custom<object>(
  (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
  { error: 'required object' }
);

const visualPromptHashInputSchema = z.object({
  scene: requiredObject,
  styleConfig: requiredObject,
  characterBible: z.array(requiredObject),
  locationBible: z.array(requiredObject),
  elementBible: z.array(requiredObject),
  aspectRatio: z.string(),
  analysisModel: z.string(),
});

const motionPromptHashInputSchema = visualPromptHashInputSchema.extend({
  startingFrameImageUrl: z.string().nullable(),
  referenceOnly: z.boolean(),
  characterVoices: z.array(voiceCharacterSchema),
});

/**
 * Runtime-parse a visual assembler DTO. A missing channel on a durable JSON
 * replay fails the run instead of hashing a different shape than verify.
 */
function assembleVisualPromptHashInput(raw: unknown): VisualPromptHashInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Zod object → assembler DTO
  return visualPromptHashInputSchema.parse(raw) as VisualPromptHashInput;
}

/**
 * Runtime-parse a motion assembler DTO. `characterVoices` is required with
 * no default — omitting it on replay is a failed run, not `[]`.
 */
export function assembleMotionPromptHashInput(
  raw: unknown
): MotionPromptHashInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Zod object → assembler DTO
  return motionPromptHashInputSchema.parse(raw) as MotionPromptHashInput;
}

/**
 * Hash-body input. Motion-only channels stay optional HERE so empty/omitted
 * is load-bearing (no stored voiceless digest moves). Callers never build
 * this; they go through {@link MotionPromptHashInput} /
 * {@link VisualPromptHashInput}.
 */
type PromptSceneContextHashInput = {
  scene: Scene;
  styleConfig: StyleConfig;
  characterBible: readonly CharacterBibleEntry[];
  locationBible: readonly LocationBibleEntry[];
  elementBible?: readonly ElementBibleEntry[];
  aspectRatio: string;
  analysisModel: string;
  startingFrameImageUrl?: string | null;
  referenceOnly?: boolean;
  dialogueVoices?: readonly DialogueVoiceHashInput[];
};

function toVisualBodyInput(
  input: VisualPromptHashInput
): PromptSceneContextHashInput {
  return {
    scene: input.scene,
    styleConfig: input.styleConfig,
    characterBible: input.characterBible,
    locationBible: input.locationBible,
    elementBible: input.elementBible,
    aspectRatio: input.aspectRatio,
    analysisModel: input.analysisModel,
  };
}

function toMotionBodyInput(
  input: MotionPromptHashInput
): PromptSceneContextHashInput {
  return {
    ...toVisualBodyInput(input),
    startingFrameImageUrl: input.startingFrameImageUrl,
    referenceOnly: input.referenceOnly,
    dialogueVoices: dialogueVoicesForHash(
      {
        presence: input.scene.originalScript.dialogue.length > 0,
        lines: input.scene.originalScript.dialogue,
      },
      input.characterVoices
    ),
  };
}

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
function sceneMetadata(scene: Scene, includeTitle: boolean) {
  if (!scene.metadata) return null;
  return {
    ...(includeTitle ? { title: scene.metadata.title } : {}),
    // `location` is the INT./EXT. heading (content), not a display label.
    location: scene.metadata.location,
    timeOfDay: scene.metadata.timeOfDay,
    storyBeat: scene.metadata.storyBeat,
  };
}

/**
 * Current stamp shape. v5 dropped `sceneNumber` from the scene surface.
 * Display labels (`name` on bibles/talent, `title` on scene metadata and
 * music summaries) are also omitted from the stamp. Verify accepts the
 * previous digests via the `*InputHashMatches` helpers until
 * {@link LEGACY_HASH_UNTIL}.
 */
const PROMPT_INPUT_HASH_VERSION = 5;
const PROMPT_INPUT_HASH_VERSION_V4 = 4;

/**
 * Delete the v4 / named / titled verify fallbacks after this date.
 * Tracking: https://github.com/openstory-so/openstory/issues/1371
 */
export const LEGACY_HASH_UNTIL = '2026-09-28';

type PromptHashKind = 'current' | 'v5-titled' | 'v5-named' | 'v4';

function promptHashFlags(kind: PromptHashKind) {
  return {
    hashVersion:
      kind === 'v4' ? PROMPT_INPUT_HASH_VERSION_V4 : PROMPT_INPUT_HASH_VERSION,
    named: kind === 'v4' || kind === 'v5-named',
    includeTitle: kind !== 'current',
    includeSceneNumber: kind === 'v4',
  };
}

function sceneInputContext(scene: Scene, kind: PromptHashKind) {
  const flags = promptHashFlags(kind);
  return {
    ...(flags.includeSceneNumber ? { sceneNumber: scene.sceneNumber } : {}),
    originalScript: scene.originalScript,
    metadata: sceneMetadata(scene, flags.includeTitle),
  };
}

/**
 * Project a bible entry down to the fields that actually drive prompt text.
 * Identity / provenance / display-label / image-gen-tag fields (`characterId`,
 * `locationId`, `name`, `consistencyTag`, `firstMention`) are handed to the
 * LLM but never hashed — a rename or a casting-tag rewrite must not flag
 * every prompt stale. Scene `metadata.title` is the same class of label.
 * The LLM still receives the full entries; only the hash is the projection.
 */
function projectCharacterForPrompt(c: CharacterBibleEntry) {
  return {
    age: trim(c.age),
    gender: trim(c.gender),
    ethnicity: trim(c.ethnicity),
    physicalDescription: trim(c.physicalDescription),
    standardClothing: trim(c.standardClothing),
    distinguishingFeatures: trim(c.distinguishingFeatures),
  };
}

function projectCharacterForPromptV4(c: CharacterBibleEntry) {
  return { name: trim(c.name), ...projectCharacterForPrompt(c) };
}

/**
 * Performance fields (#1561) drive the MOTION prompt only — a still does not
 * walk, so the visual prompt and the sheet never hash them. Each joins the
 * body only when set, the same shape-stable trick as `referenceOnly`: no
 * stored digest moves for a character that has neither.
 */
function projectCharacterPerformance(c: CharacterBibleEntry) {
  const personality = trim(c.personality);
  const movement = trim(c.movement);
  return {
    ...(personality ? { personality } : {}),
    ...(movement ? { movement } : {}),
  };
}

function projectLocationForPrompt(l: LocationBibleEntry) {
  return {
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

function projectLocationForPromptV4(l: LocationBibleEntry) {
  return { name: trim(l.name), ...projectLocationForPrompt(l) };
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

function promptBibleProjection(
  input: PromptSceneContextHashInput,
  { named, performance }: { named: boolean; performance: boolean }
) {
  const bibles = sortedBibles(input);
  const character = named
    ? projectCharacterForPromptV4
    : projectCharacterForPrompt;
  const location = named
    ? projectLocationForPromptV4
    : projectLocationForPrompt;
  return {
    characterBible: bibles.characterBible.map((c) => ({
      ...character(c),
      ...(performance ? projectCharacterPerformance(c) : {}),
    })),
    locationBible: bibles.locationBible.map(location),
    elementBible: bibles.elementBible
      ? bibles.elementBible.map(projectElementForPrompt)
      : null,
  };
}

function visualPromptHashBody(
  input: PromptSceneContextHashInput,
  kind: PromptHashKind
): unknown {
  const flags = promptHashFlags(kind);
  const bibles = promptBibleProjection(input, {
    named: flags.named,
    performance: false,
  });
  return {
    artifact: 'shot:visual-prompt',
    hashVersion: flags.hashVersion,
    scene: sceneInputContext(input.scene, kind),
    styleConfig: styleConfigHashBody(input.styleConfig),
    ...bibles,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
  };
}

function motionPromptHashBody(
  input: PromptSceneContextHashInput,
  kind: PromptHashKind
): unknown {
  const flags = promptHashFlags(kind);
  const bibles = promptBibleProjection(input, {
    named: flags.named,
    performance: true,
  });
  const dialogueVoices = dialogueVoicesHashBody(input.dialogueVoices);
  return {
    artifact: 'shot:motion-prompt',
    hashVersion: flags.hashVersion,
    scene: sceneInputContext(input.scene, kind),
    styleConfig: styleConfigHashBody(input.styleConfig),
    ...bibles,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
    startingFrameImageUrl: trim(input.startingFrameImageUrl),
    ...(input.referenceOnly ? { referenceOnly: true } : {}),
    ...(dialogueVoices ? { dialogueVoices } : {}),
  };
}

export async function hashVisualPromptInput(
  raw: VisualPromptHashInput | MotionPromptHashInput
): Promise<VisualPromptInputHash> {
  const input = assembleVisualPromptHashInput(raw);
  return visualPromptInputHash(
    await sha256Hex(visualPromptHashBody(toVisualBodyInput(input), 'current'))
  );
}

/** v4 digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export async function computeVisualPromptInputHashV4(
  raw: VisualPromptHashInput | MotionPromptHashInput
): Promise<string> {
  const input = assembleVisualPromptHashInput(raw);
  return sha256Hex(visualPromptHashBody(toVisualBodyInput(input), 'v4'));
}

/**
 * True if `stored` matches the current digest or a legacy v4 / v5-named
 * digest of the same inputs. Remove after {@link LEGACY_HASH_UNTIL}.
 */
export async function visualPromptInputHashMatches(
  stored: string | null,
  raw: VisualPromptHashInput | MotionPromptHashInput
): Promise<boolean> {
  if (!stored) return false;
  const input = toVisualBodyInput(assembleVisualPromptHashInput(raw));
  const [current, v5titled, v5named, v4] = await Promise.all([
    sha256Hex(visualPromptHashBody(input, 'current')),
    sha256Hex(visualPromptHashBody(input, 'v5-titled')),
    sha256Hex(visualPromptHashBody(input, 'v5-named')),
    sha256Hex(visualPromptHashBody(input, 'v4')),
  ]);
  return (
    stored === current ||
    stored === v5titled ||
    stored === v5named ||
    stored === v4
  );
}

export async function hashMotionPromptInput(
  raw: MotionPromptHashInput
): Promise<MotionPromptInputHash> {
  const input = assembleMotionPromptHashInput(raw);
  return motionPromptInputHash(
    await sha256Hex(motionPromptHashBody(toMotionBodyInput(input), 'current'))
  );
}

/** v4 digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export async function computeMotionPromptInputHashV4(
  raw: MotionPromptHashInput
): Promise<string> {
  const input = assembleMotionPromptHashInput(raw);
  return sha256Hex(motionPromptHashBody(toMotionBodyInput(input), 'v4'));
}

export async function motionPromptInputHashMatches(
  stored: string | null,
  raw: MotionPromptHashInput
): Promise<boolean> {
  if (!stored) return false;
  const input = toMotionBodyInput(assembleMotionPromptHashInput(raw));
  const [current, v5titled, v5named, v4] = await Promise.all([
    sha256Hex(motionPromptHashBody(input, 'current')),
    sha256Hex(motionPromptHashBody(input, 'v5-titled')),
    sha256Hex(motionPromptHashBody(input, 'v5-named')),
    sha256Hex(motionPromptHashBody(input, 'v4')),
  ]);
  return (
    stored === current ||
    stored === v5titled ||
    stored === v5named ||
    stored === v4
  );
}

export type MusicPromptInputHashInput = {
  /** Compact scene summaries fed to the music LLM — the actual upstream input. */
  sceneSummaries: readonly MusicSceneSummary[];
  analysisModel: string;
};

type MusicHashKind = 'current' | 'v5-titled' | 'v4';

function projectMusicSceneSummary(
  summary: MusicSceneSummary,
  includeTitle: boolean
) {
  if (includeTitle) return summary;
  return {
    sceneId: summary.sceneId,
    storyBeat: summary.storyBeat,
    durationSeconds: summary.durationSeconds,
    location: summary.location,
    timeOfDay: summary.timeOfDay,
    visualSummary: summary.visualSummary,
  };
}

function musicPromptHashBody(
  input: MusicPromptInputHashInput,
  kind: MusicHashKind
): unknown {
  return {
    artifact: 'sequence:music-prompt',
    hashVersion: kind === 'v4' ? 4 : PROMPT_INPUT_HASH_VERSION,
    sceneSummaries: input.sceneSummaries.map((summary) =>
      projectMusicSceneSummary(summary, kind !== 'current')
    ),
    analysisModel: trim(input.analysisModel),
  };
}

export function computeMusicPromptInputHash(
  input: MusicPromptInputHashInput
): Promise<string> {
  return sha256Hex(musicPromptHashBody(input, 'current'));
}

/** v4 digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export function computeMusicPromptInputHashV4(
  input: MusicPromptInputHashInput
): Promise<string> {
  return sha256Hex(musicPromptHashBody(input, 'v4'));
}

export async function musicPromptInputHashMatches(
  stored: string | null,
  input: MusicPromptInputHashInput
): Promise<boolean> {
  if (!stored) return false;
  const [current, v5titled, v4] = await Promise.all([
    sha256Hex(musicPromptHashBody(input, 'current')),
    sha256Hex(musicPromptHashBody(input, 'v5-titled')),
    sha256Hex(musicPromptHashBody(input, 'v4')),
  ]);
  return stored === current || stored === v5titled || stored === v4;
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
