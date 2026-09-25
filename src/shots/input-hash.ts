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

import { z } from 'zod';
import { tokensRegex } from '@/cast/cascade-rename';

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

/**
 * Branded artifact digests (#1616). Hasher return types and the write APIs
 * that persist them take the brand, so `sha256Hex({ kind, text })` cannot be
 * stored as an `inputHash`. Constructors are the sole mint besides the
 * hasher — tests use them for fixture rows.
 */
export type ShotImageInputHash = string & {
  readonly __brand: 'ShotImageInputHash';
};
export type VideoManifestInputHash = string & {
  readonly __brand: 'VideoManifestInputHash';
};
export type CharacterSheetInputHash = string & {
  readonly __brand: 'CharacterSheetInputHash';
};
export type LocationSheetInputHash = string & {
  readonly __brand: 'LocationSheetInputHash';
};
export type LibraryLocationReferenceInputHash = string & {
  readonly __brand: 'LibraryLocationReferenceInputHash';
};
export type TalentSheetInputHash = string & {
  readonly __brand: 'TalentSheetInputHash';
};
export type MusicPromptInputHash = string & {
  readonly __brand: 'MusicPromptInputHash';
};
export type SequenceMusicInputHash = string & {
  readonly __brand: 'SequenceMusicInputHash';
};

/* oxlint-disable typescript/no-unsafe-type-assertion -- sole brand constructors */
export const shotImageInputHash = (hex: string): ShotImageInputHash =>
  hex as ShotImageInputHash;
export const videoManifestInputHash = (hex: string): VideoManifestInputHash =>
  hex as VideoManifestInputHash;
export const characterSheetInputHash = (hex: string): CharacterSheetInputHash =>
  hex as CharacterSheetInputHash;
export const locationSheetInputHash = (hex: string): LocationSheetInputHash =>
  hex as LocationSheetInputHash;
export const libraryLocationReferenceInputHash = (
  hex: string
): LibraryLocationReferenceInputHash =>
  hex as LibraryLocationReferenceInputHash;
export const talentSheetInputHash = (hex: string): TalentSheetInputHash =>
  hex as TalentSheetInputHash;
export const musicPromptInputHash = (hex: string): MusicPromptInputHash =>
  hex as MusicPromptInputHash;
export const sequenceMusicInputHash = (hex: string): SequenceMusicInputHash =>
  hex as SequenceMusicInputHash;
/* oxlint-enable typescript/no-unsafe-type-assertion */

const trim = (s: string | null | undefined): string => (s ?? '').trim();

/** Sort an unordered set of strings so the hash is order-insensitive. */
const sortedRefs = (refs: readonly string[]): string[] => [...refs].sort();

/**
 * An element's token is a label (#1827): renaming it must not stale the
 * stills and prompts whose text names it. Every hash reads text through
 * {@link elementTokensToKeys}, which swaps each token for the element's
 * identity — its id on a still, its description in a prompt, whose element
 * bible has no id (the analysis LLM writes it). The text SENT to a model is
 * never touched; only what is hashed.
 */
type HashElement = { token: string; key: string };

function elementTokensToKeys(
  text: string,
  elements: readonly HashElement[]
): string {
  const keyByToken = new Map(
    elements.filter((e) => e.token).map((e) => [e.token.toUpperCase(), e.key])
  );
  if (!text || keyByToken.size === 0) return text;
  // One pass, so a key's own words are never read as a token.
  return text.replace(
    tokensRegex([...keyByToken.keys()]),
    (_match, boundary: string, token: string) =>
      `${boundary}\u27E6element:${keyByToken.get(token.toUpperCase())}\u27E7`
  );
}

/** A still's elements as its hash sees them: the token and its row id. */
export type ElementToken = { token: string; id: string };

export const elementTokensOf = (
  elements: readonly ElementToken[]
): ElementToken[] => elements.map(({ token, id }) => ({ token, id }));

type ShotImageHashFields = {
  visualPrompt: string;
  imageModel: string;
  aspectRatio: string;
  /** Required; `null` is "no size". Omitting it is a stamp/verify hole. */
  size: string | null;
  /** Required; `null` is "no seed". */
  seed: number | null;
  characterSheetHashes: readonly string[];
  locationSheetHashes: readonly string[];
  elementReferenceHashes: readonly string[];
  /** The elements whose tokens the prompt may name (#1827). */
  elementTokens: readonly ElementToken[];
};

type ShotImageHashKind = 'thumbnail' | 'variant-image';

export type ShotImageHashInput = ShotImageHashFields & {
  kind: ShotImageHashKind;
};

const shotImageHashInputSchema = z.object({
  kind: z.enum(['thumbnail', 'variant-image']),
  visualPrompt: z.string(),
  imageModel: z.string(),
  aspectRatio: z.string(),
  size: z.string().nullable(),
  seed: z.number().nullable(),
  characterSheetHashes: z.array(z.string()),
  locationSheetHashes: z.array(z.string()),
  elementReferenceHashes: z.array(z.string()),
  // Defaulted, not required, only for a payload made before #1827 deployed:
  // no elements hashes the raw text, the legacy digest verify still accepts.
  elementTokens: z
    .array(z.object({ token: z.string(), id: z.string() }))
    .default([]),
});

function shotImageHashBody(
  input: z.infer<typeof shotImageHashInputSchema>,
  tokenFree: boolean
): unknown {
  const visualPrompt = trim(input.visualPrompt);
  return {
    artifact: `shot:${input.kind}`,
    visualPrompt: tokenFree
      ? elementTokensToKeys(
          visualPrompt,
          input.elementTokens.map(({ token, id }) => ({ token, key: id }))
        )
      : visualPrompt,
    imageModel: input.imageModel,
    aspectRatio: input.aspectRatio,
    size: input.size,
    seed: input.seed,
    characterSheetHashes: sortedRefs(input.characterSheetHashes),
    locationSheetHashes: sortedRefs(input.locationSheetHashes),
    elementReferenceHashes: sortedRefs(input.elementReferenceHashes),
  };
}

export function computeShotImageInputHash(
  raw: ShotImageHashInput
): Promise<ShotImageInputHash> {
  const input = shotImageHashInputSchema.parse(raw);
  return sha256Hex(shotImageHashBody(input, true)).then(shotImageInputHash);
}

/**
 * Verify: the current digest, or the pre-#1827 one that hashed the prompt's
 * tokens raw. Delete the fallback after {@link LEGACY_HASH_UNTIL}.
 */
export async function shotImageInputHashMatches(
  stored: string | null,
  raw: ShotImageHashInput
): Promise<boolean> {
  if (!stored) return false;
  const input = shotImageHashInputSchema.parse(raw);
  const digests = await Promise.all(
    [true, false].map((tokenFree) =>
      sha256Hex(shotImageHashBody(input, tokenFree))
    )
  );
  return digests.includes(stored);
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
const videoManifestHashEntrySchema = z.object({
  shotId: z.string(),
  motionPromptVersionId: z.string().nullable(),
  frameVersionId: z.string().nullable(),
  usesStartFrame: z.boolean(),
  durationMs: z.number(),
  audioClipIds: z.array(z.string()),
  audioSourceKey: z.string().nullable(),
  // Nullish: a draft from before #1784 lends its manifest to the final.
  dialogueKey: z.string().nullish(),
  referenceKeys: z.array(z.string()),
});

function canonicalizeManifestEntry(
  entry: z.infer<typeof videoManifestHashEntrySchema>
): unknown {
  return {
    shotId: entry.shotId,
    motionPromptVersionId: entry.motionPromptVersionId,
    frameVersionId: entry.frameVersionId,
    usesStartFrame: entry.usesStartFrame,
    durationMs: entry.durationMs,
    ...(entry.audioClipIds.length > 0
      ? { audioClipIds: entry.audioClipIds }
      : {}),
    ...(entry.audioSourceKey ? { audioSourceKey: entry.audioSourceKey } : {}),
    ...(entry.dialogueKey ? { dialogueKey: entry.dialogueKey } : {}),
    ...(entry.referenceKeys.length > 0
      ? { referenceKeys: [...entry.referenceKeys].sort() }
      : {}),
  };
}

export function computeVideoManifestInputHash(
  manifest: readonly VideoManifestEntry[],
  model: string
): Promise<VideoManifestInputHash | null> {
  const entries = z.array(videoManifestHashEntrySchema).parse(manifest);
  // A hash over null/null immediately diverges from a live hash built from
  // the selected still + prompt — that's how storyboard clips were born
  // Stale (#1380). Unknown provenance is a null hash: never stale, like
  // `isSelectedVersionStale` on a legacy row.
  if (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry.motionPromptVersionId == null && entry.frameVersionId == null
    )
  ) {
    return Promise.resolve(null);
  }
  return sha256Hex({
    artifact: 'video:manifest',
    model,
    manifest: entries.map(canonicalizeManifestEntry),
  }).then(videoManifestInputHash);
}

export type CharacterBibleHashFields = {
  name: string;
  age: string;
  gender: string | null;
  ethnicity: string | null;
  physicalDescription: string | null;
  standardClothing: string | null;
  distinguishingFeatures: string | null;
  consistencyTag: string | null;
  /** Not hashed — BytePlus registration only (#1682). */
  isPerson?: boolean;
};

/**
 * What the character-sheet prompt reads from a cast talent (#1785), resolved
 * live by `resolveCastTalent`. `description` is the talent row's own text, not
 * the path-specific prompt wording built from it, so every stamp path hashes
 * what verify recomputes. `sheetImageUrl` / `sheetLook` are the default talent
 * sheet the prompt copies — a promoted variant keeps its sheet's `inputHash`
 * but changes the image.
 */
export type CharacterSheetTalentHashFields = {
  description: string | null;
  sheetImageUrl: string | null;
  /** Required; `null` is "the talent sheet has no look metadata". */
  sheetLook: {
    age: string | null;
    gender: string | null;
    ethnicity: string | null;
    physicalDescription: string | null;
  } | null;
};

export type CharacterSheetHashInput = {
  characterBible: CharacterBibleHashFields;
  /** Required; `null` is "no talent sheet". */
  talentSheetHash: string | null;
  /** Required; `null` is "not cast". */
  talent: CharacterSheetTalentHashFields | null;
  styleConfigHash: string;
  imageModel: string;
};

/**
 * Sheet digest shapes. `current` hashes the cast talent (#1785) and drops the
 * name; `pre-1785` is the nameless digest without the talent channel;
 * `named` is the pre-#1108 digest. Verify accepts the legacy two until
 * {@link LEGACY_HASH_UNTIL}.
 */
type SheetHashKind = 'current' | 'pre-1785' | 'named';

function characterSheetHashBody(
  input: CharacterSheetHashInput,
  kind: SheetHashKind
): unknown {
  const cb = input.characterBible;
  const talent = kind === 'current' ? input.talent : null;
  return {
    artifact: 'character:sheet',
    characterBible: {
      ...(kind === 'named' ? { name: trim(cb.name) } : {}),
      age: trim(cb.age),
      gender: trim(cb.gender),
      ethnicity: trim(cb.ethnicity),
      physicalDescription: trim(cb.physicalDescription),
      standardClothing: trim(cb.standardClothing),
      distinguishingFeatures: trim(cb.distinguishingFeatures),
      consistencyTag: trim(cb.consistencyTag),
    },
    talentSheetHash: input.talentSheetHash ?? null,
    // Joined only when cast, so no uncast character's digest moves.
    ...(talent
      ? {
          talent: {
            description: trim(talent.description),
            sheetImageUrl: trim(talent.sheetImageUrl),
            sheetLook: talent.sheetLook
              ? {
                  age: trim(talent.sheetLook.age),
                  gender: trim(talent.sheetLook.gender),
                  ethnicity: trim(talent.sheetLook.ethnicity),
                  physicalDescription: trim(
                    talent.sheetLook.physicalDescription
                  ),
                }
              : null,
          },
        }
      : {}),
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  };
}

const characterBibleHashFieldsSchema = z.object({
  name: z.string(),
  age: z.string(),
  gender: z.string().nullable(),
  ethnicity: z.string().nullable(),
  physicalDescription: z.string().nullable(),
  standardClothing: z.string().nullable(),
  distinguishingFeatures: z.string().nullable(),
  consistencyTag: z.string().nullable(),
});

const characterSheetHashInputSchema = z.object({
  characterBible: characterBibleHashFieldsSchema,
  talentSheetHash: z.string().nullable(),
  talent: z
    .object({
      description: z.string().nullable(),
      sheetImageUrl: z.string().nullable(),
      sheetLook: z
        .object({
          age: z.string().nullable(),
          gender: z.string().nullable(),
          ethnicity: z.string().nullable(),
          physicalDescription: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  styleConfigHash: z.string(),
  imageModel: z.string(),
});

export function computeCharacterSheetInputHash(
  raw: CharacterSheetHashInput
): Promise<CharacterSheetInputHash> {
  const input = characterSheetHashInputSchema.parse(raw);
  return sha256Hex(characterSheetHashBody(input, 'current')).then(
    characterSheetInputHash
  );
}

/** Named-bible digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export function computeCharacterSheetInputHashLegacy(
  raw: CharacterSheetHashInput
): Promise<string> {
  const input = characterSheetHashInputSchema.parse(raw);
  return sha256Hex(characterSheetHashBody(input, 'named'));
}

/** Verify: the current digest, or a pre-#1785 / pre-#1108 one. */
export async function characterSheetInputHashMatches(
  stored: string | null,
  raw: CharacterSheetHashInput
): Promise<boolean> {
  if (!stored) return false;
  const input = characterSheetHashInputSchema.parse(raw);
  const digests = await Promise.all(
    (['current', 'pre-1785', 'named'] as const).map((kind) =>
      sha256Hex(characterSheetHashBody(input, kind))
    )
  );
  return digests.includes(stored);
}

type LocationBibleHashFields = {
  name: string;
  description: string | null;
};

/**
 * Every bible field the location-sheet prompt reads (#1785). `name` is a
 * label, hashed only by the pre-#1108 digest.
 */
export type LocationSheetBibleHashFields = LocationBibleHashFields &
  Pick<
    LocationBibleEntry,
    | 'type'
    | 'timeOfDay'
    | 'architecturalStyle'
    | 'keyFeatures'
    | 'colorPalette'
    | 'lightingSetup'
    | 'ambiance'
  >;

export type LocationSheetHashInput = {
  locationBible: LocationSheetBibleHashFields;
  /** Required; `null` is "no library reference". */
  libraryLocationReferenceHash: string | null;
  styleConfigHash: string;
  imageModel: string;
};

function locationSheetHashBody(
  input: LocationSheetHashInput,
  kind: SheetHashKind
): unknown {
  const lb = input.locationBible;
  return {
    artifact: 'location:sheet',
    locationBible:
      kind === 'current'
        ? projectLocationForPrompt(lb)
        : {
            ...(kind === 'named' ? { name: trim(lb.name) } : {}),
            description: trim(lb.description),
          },
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  };
}

const locationBibleHashFieldsSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
});

const locationSheetHashInputSchema = z.object({
  locationBible: locationBibleHashFieldsSchema.extend({
    type: z.enum(['interior', 'exterior', 'both']),
    timeOfDay: z.string(),
    architecturalStyle: z.string(),
    keyFeatures: z.string(),
    colorPalette: z.string(),
    lightingSetup: z.string(),
    ambiance: z.string(),
  }),
  libraryLocationReferenceHash: z.string().nullable(),
  styleConfigHash: z.string(),
  imageModel: z.string(),
});

export function computeLocationSheetInputHash(
  raw: LocationSheetHashInput
): Promise<LocationSheetInputHash> {
  const input = locationSheetHashInputSchema.parse(raw);
  return sha256Hex(locationSheetHashBody(input, 'current')).then(
    locationSheetInputHash
  );
}

/** Verify: the current digest, or a pre-#1785 / pre-#1108 one. */
export async function locationSheetInputHashMatches(
  stored: string | null,
  raw: LocationSheetHashInput
): Promise<boolean> {
  if (!stored) return false;
  const input = locationSheetHashInputSchema.parse(raw);
  const digests = await Promise.all(
    (['current', 'pre-1785', 'named'] as const).map((kind) =>
      sha256Hex(locationSheetHashBody(input, kind))
    )
  );
  return digests.includes(stored);
}

export type LibraryLocationReferenceHashInput = {
  locationBible: LocationBibleHashFields;
  styleConfigHash: string;
  imageModel: string;
  /** Required; `[]` is "no reference media". */
  referenceMediaHashes: readonly string[];
};

function libraryLocationReferenceHashBody(
  input: LibraryLocationReferenceHashInput
): unknown {
  return {
    artifact: 'library-location:reference',
    locationBible: { description: trim(input.locationBible.description) },
    referenceMediaHashes: sortedRefs(input.referenceMediaHashes),
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  };
}

const libraryLocationReferenceHashInputSchema = z.object({
  locationBible: locationBibleHashFieldsSchema,
  styleConfigHash: z.string(),
  imageModel: z.string(),
  referenceMediaHashes: z.array(z.string()),
});

export function computeLibraryLocationReferenceInputHash(
  raw: LibraryLocationReferenceHashInput
): Promise<LibraryLocationReferenceInputHash> {
  const input = libraryLocationReferenceHashInputSchema.parse(raw);
  return sha256Hex(libraryLocationReferenceHashBody(input)).then(
    libraryLocationReferenceInputHash
  );
}

export type TalentSheetHashInput = {
  talent: {
    name: string;
    description: string | null;
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

const talentSheetHashInputSchema = z.object({
  talent: z.object({
    name: z.string(),
    description: z.string().nullable(),
  }),
  referenceMediaHashes: z.array(z.string()),
  imageModel: z.string(),
});

export function computeTalentSheetInputHash(
  raw: TalentSheetHashInput
): Promise<TalentSheetInputHash> {
  const input = talentSheetHashInputSchema.parse(raw);
  return sha256Hex(talentSheetHashBody(input, false)).then(
    talentSheetInputHash
  );
}

/** Named-talent digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export function computeTalentSheetInputHashLegacy(
  raw: TalentSheetHashInput
): Promise<string> {
  const input = talentSheetHashInputSchema.parse(raw);
  return sha256Hex(talentSheetHashBody(input, true));
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
  MotionDialogue,
  Scene,
} from './scene-analysis.schema';
import type { MusicSceneSummary } from '@/platform/server/workflow/types';
import type {
  StyleConfig,
  VideoManifestEntry,
} from '@/platform/server/db/schema';
import { styleConfigHashBody } from '@/look/style-config';

/**
 * Visual-prompt assembler DTO (#1616). Every channel is required so stamp
 * and verify cannot independently omit a field. Empty bibles are spelled
 * `[]`, not omitted.
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
 * motion-only ones, all required. Voice ids are not a prompt channel —
 * they bind on the clip (`VideoManifestEntry.audioSourceKey`), like
 * character sheets on the still.
 *
 * `dialogue` is what the shot says now (`shotDialogueResolver`, #1784). It
 * replaces the script's lines in the scene the LLM reads and this hash
 * hashes ({@link sceneWithShotDialogue}), so a shot line edit re-stales the
 * prompt. Required, so no stamp or verify can fall back to the script.
 */
export type MotionPromptHashInput = VisualPromptHashInput & {
  startingFrameImageUrl: string | null;
  referenceOnly: boolean;
  dialogue: MotionDialogue;
};

/**
 * The scene the motion prompt is written from (#1784): the script with its
 * dialogue replaced by what the shot says now. The motion LLM reads this and
 * the motion hash hashes it. `voiceToken` is dropped: it binds a voice on the
 * clip, never the prompt, and the LLM cannot know which elements exist.
 */
export function sceneWithShotDialogue(
  scene: Scene,
  dialogue: MotionDialogue
): Scene {
  return {
    ...scene,
    originalScript: {
      ...scene.originalScript,
      dialogue: dialogue.lines.map(({ character, line, tone }) => ({
        character,
        line,
        tone,
      })),
    },
  };
}

export type VisualPromptInputHash = string & {
  readonly __brand: 'VisualPromptInputHash';
};
export type MotionPromptInputHash = string & {
  readonly __brand: 'MotionPromptInputHash';
};

/* oxlint-disable typescript/no-unsafe-type-assertion -- sole brand constructors */
export const visualPromptInputHash = (hex: string): VisualPromptInputHash =>
  hex as VisualPromptInputHash;
export const motionPromptInputHash = (hex: string): MotionPromptInputHash =>
  hex as MotionPromptInputHash;
/* oxlint-enable typescript/no-unsafe-type-assertion */

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
  dialogue: requiredObject,
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
 * Runtime-parse a motion assembler DTO. A missing channel on a durable JSON
 * replay fails the run instead of hashing a different shape than verify.
 */
export function assembleMotionPromptHashInput(
  raw: unknown
): MotionPromptHashInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Zod object → assembler DTO
  return motionPromptHashInputSchema.parse(raw) as MotionPromptHashInput;
}

/**
 * Hash-body input. Motion-only channels stay optional HERE so empty/omitted
 * is load-bearing (no stored voiceless / i2v digest moves). Callers never
 * build this; they go through {@link MotionPromptHashInput} /
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

/**
 * `scriptDialogue` hashes the scene's own script lines — the shape every
 * motion digest had before #1784. Verify-only, see
 * {@link motionPromptInputHashMatches}.
 */
function toMotionBodyInput(
  input: MotionPromptHashInput,
  scriptDialogue = false
): PromptSceneContextHashInput {
  return {
    ...toVisualBodyInput(input),
    scene: scriptDialogue
      ? input.scene
      : sceneWithShotDialogue(input.scene, input.dialogue),
    startingFrameImageUrl: input.startingFrameImageUrl,
    referenceOnly: input.referenceOnly,
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
 * video parameter (the clip compares it through the render manifest), not a
 * prompt driver.
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
// Milestone 24 (#1783–#1787, #1827) added fallbacks under this date; they
// need ~a month after that stack deploys, or everything stamped before it flips stale.
export const LEGACY_HASH_UNTIL = '2026-12-31';

/**
 * `v5-tokened` is the current shape before #1827 read element tokens as
 * labels. `v5-voiced` is that shape before #1785 took voice-only characters
 * out of the visual body and #1787 marked them in the motion body; the older
 * legacy shapes predate both.
 */
type PromptHashKind =
  | 'current'
  | 'v5-tokened'
  | 'v5-voiced'
  | 'v5-titled'
  | 'v5-named'
  | 'v4';

function promptHashFlags(kind: PromptHashKind) {
  return {
    hashVersion:
      kind === 'v4' ? PROMPT_INPUT_HASH_VERSION_V4 : PROMPT_INPUT_HASH_VERSION,
    named: kind === 'v4' || kind === 'v5-named',
    includeTitle:
      kind !== 'current' && kind !== 'v5-tokened' && kind !== 'v5-voiced',
    includeSceneNumber: kind === 'v4',
    keepVoiceOnly: kind !== 'current' && kind !== 'v5-tokened',
    tokenFree: kind === 'current',
  };
}

/** Every string in `value` with element tokens swapped for identities. */
function withElementKeys<T>(value: T, elements: readonly HashElement[]): T {
  if (typeof value === 'string') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- string in, string out
    return elementTokensToKeys(value, elements) as T;
  }
  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same shape
    return value.map((v: unknown) => withElementKeys(v, elements)) as T;
  }
  if (value !== null && typeof value === 'object') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same shape
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withElementKeys(v, elements)])
    ) as T;
  }
  return value;
}

/** A prompt's element bible has no id; an element is its description. */
const promptHashElements = (
  input: PromptSceneContextHashInput
): HashElement[] =>
  (input.elementBible ?? []).map((e) => ({
    token: e.token,
    key: trim(e.description),
  }));

function sceneInputContext(
  input: PromptSceneContextHashInput,
  kind: PromptHashKind
) {
  const { scene } = input;
  const flags = promptHashFlags(kind);
  const context = {
    ...(flags.includeSceneNumber ? { sceneNumber: scene.sceneNumber } : {}),
    originalScript: scene.originalScript,
    metadata: sceneMetadata(scene, flags.includeTitle),
  };
  return flags.tokenFree
    ? withElementKeys(context, promptHashElements(input))
    : context;
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

function projectLocationForPrompt(
  l: Omit<LocationSheetBibleHashFields, 'name'>
) {
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

function projectElementForPrompt(e: ElementBibleEntry, tokenFree: boolean) {
  return {
    ...(tokenFree ? {} : { token: trim(e.token) }),
    description: trim(e.description),
  };
}

/**
 * Bibles are conceptually sets — re-ordering by the LLM or DB readback must
 * not produce a different hash. Sorting by the analysis identity field makes
 * the hash order-insensitive while keeping each row's structure intact.
 */
function sortedBibles(input: PromptSceneContextHashInput, tokenFree: boolean) {
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
      ? byKey(input.elementBible, (e) =>
          tokenFree ? trim(e.description) : e.token
        )
      : null,
  };
}

function promptBibleProjection(
  input: PromptSceneContextHashInput,
  {
    named,
    performance,
    markVoiceOnly = false,
    tokenFree,
  }: {
    named: boolean;
    performance: boolean;
    markVoiceOnly?: boolean;
    tokenFree: boolean;
  }
) {
  const bibles = sortedBibles(input, tokenFree);
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
      ...(markVoiceOnly && c.voiceOnly ? { voiceOnly: true } : {}),
    })),
    locationBible: bibles.locationBible.map(location),
    elementBible: bibles.elementBible
      ? bibles.elementBible.map((e) => projectElementForPrompt(e, tokenFree))
      : null,
  };
}

function visualPromptHashBody(
  input: PromptSceneContextHashInput,
  kind: PromptHashKind
): unknown {
  const flags = promptHashFlags(kind);
  // A voice-only character is heard, never framed (#1585): the visual LLM
  // never sees it, so neither does this hash. Toggling `voiceOnly` still
  // moves the digest — the entry leaves or joins the bible.
  const bibles = promptBibleProjection(
    flags.keepVoiceOnly
      ? input
      : {
          ...input,
          characterBible: input.characterBible.filter((c) => !c.voiceOnly),
        },
    { named: flags.named, performance: false, tokenFree: flags.tokenFree }
  );
  return {
    artifact: 'shot:visual-prompt',
    hashVersion: flags.hashVersion,
    scene: sceneInputContext(input, kind),
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
  // The motion LLM is sent `voiceOnly` (a heard, unframed character), so
  // the hash reads it (#1787). Only when set, so no stored digest moves for
  // a cast with no voice-only character; older shapes never read it.
  const bibles = promptBibleProjection(input, {
    named: flags.named,
    performance: true,
    markVoiceOnly: !flags.keepVoiceOnly,
    tokenFree: flags.tokenFree,
  });
  return {
    artifact: 'shot:motion-prompt',
    hashVersion: flags.hashVersion,
    scene: sceneInputContext(input, kind),
    styleConfig: styleConfigHashBody(input.styleConfig),
    ...bibles,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
    startingFrameImageUrl: trim(input.startingFrameImageUrl),
    ...(input.referenceOnly ? { referenceOnly: true } : {}),
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
 * True if any character's voice-only flag changed after `at` (#1787).
 * `versions` are the sequence's character bible versions, oldest first. A
 * character's first version (a backfill, a new character) is not a change.
 */
export function voiceOnlyMovedSince(
  versions: readonly {
    characterId: string;
    voiceOnly: boolean;
    createdAt: Date;
  }[],
  at: Date
): boolean {
  const last = new Map<string, boolean>();
  for (const v of versions) {
    const prev = last.get(v.characterId);
    if (
      prev !== undefined &&
      prev !== v.voiceOnly &&
      v.createdAt.getTime() > at.getTime()
    ) {
      return true;
    }
    last.set(v.characterId, v.voiceOnly);
  }
  return false;
}

/**
 * Every shape before the current one ignores the voice-only flag, so a
 * legacy digest is trusted only while no flag moved since the stamp —
 * otherwise it would equal the stamp and hide the change (#1787).
 */
function acceptedKinds<K extends PromptHashKind>(
  legacy: readonly K[],
  voiceOnlyMoved: boolean
): readonly ('current' | 'v5-tokened' | K)[] {
  // `v5-tokened` reads the flag like `current` does, so it is always safe.
  return voiceOnlyMoved
    ? ['current', 'v5-tokened']
    : ['current', 'v5-tokened', ...legacy];
}

/**
 * True if `stored` matches the current digest or a legacy v4 / v5-named
 * digest of the same inputs. Remove after {@link LEGACY_HASH_UNTIL}.
 * `voiceOnlyMoved`: {@link voiceOnlyMovedSince} the stamp.
 */
export async function visualPromptInputHashMatches(
  stored: string | null,
  raw: VisualPromptHashInput | MotionPromptHashInput,
  { voiceOnlyMoved }: { voiceOnlyMoved: boolean }
): Promise<boolean> {
  if (!stored) return false;
  const input = toVisualBodyInput(assembleVisualPromptHashInput(raw));
  const kinds = acceptedKinds(
    ['v5-voiced', 'v5-titled', 'v5-named', 'v4'] as const,
    voiceOnlyMoved
  );
  const digests = await Promise.all(
    kinds.map((kind) => sha256Hex(visualPromptHashBody(input, kind)))
  );
  return digests.includes(stored);
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

/**
 * True if `stored` matches the current digest or a legacy v5-titled /
 * v5-named / v4 digest of the same inputs. Remove after
 * {@link LEGACY_HASH_UNTIL}. `voiceOnlyMoved`: as for the visual verify.
 *
 * `legacyScriptDialogue` (#1784): before #1784 every motion digest hashed the
 * script's lines, not the shot's. Pass true only when the shot has no row on
 * its dialogue node — then no line edit can hide behind a script-shaped
 * digest, and the pre-#1784 shapes are matched too. A shot with a node row
 * never needs them: an unedited seed hashes the same lines either way.
 */
export async function motionPromptInputHashMatches(
  stored: string | null,
  raw: MotionPromptHashInput,
  {
    legacyScriptDialogue,
    voiceOnlyMoved,
  }: { legacyScriptDialogue: boolean; voiceOnlyMoved: boolean }
): Promise<boolean> {
  if (!stored) return false;
  const assembled = assembleMotionPromptHashInput(raw);
  const inputs = legacyScriptDialogue
    ? [toMotionBodyInput(assembled), toMotionBodyInput(assembled, true)]
    : [toMotionBodyInput(assembled)];
  const kinds = acceptedKinds(
    ['v5-voiced', 'v5-titled', 'v5-named', 'v4'] as const,
    voiceOnlyMoved
  );
  const digests = await Promise.all(
    inputs.flatMap((input) =>
      kinds.map((kind) => sha256Hex(motionPromptHashBody(input, kind)))
    )
  );
  return digests.includes(stored);
}

export type MusicPromptInputHashInput = {
  /**
   * One summary per scene, exactly what the music LLM reads — built by
   * `music-scene-summaries.ts` for the stamp and the verify alike (#1783).
   */
  sceneSummaries: readonly MusicSceneSummary[];
  analysisModel: string;
};

/**
 * The pre-#1783 verify shape: one row per SHOT, the DB scene id, and an
 * always-empty `visualSummary`. Verify only — delete with the legacy kinds
 * after {@link LEGACY_HASH_UNTIL}.
 */
export type LegacyMusicShotSummary = MusicSceneSummary & {
  visualSummary: string;
};

/**
 * #1783: per scene, content only. The scene id is left out (order is the
 * key, and the pipeline's analysis id is not the row id) and so is the title
 * (a display label), as for the prompt hashes.
 */
function musicPromptHashBody(input: MusicPromptInputHashInput): unknown {
  return {
    artifact: 'sequence:music-prompt',
    hashVersion: 6,
    sceneSummaries: input.sceneSummaries.map((summary) => ({
      storyBeat: summary.storyBeat,
      durationSeconds: summary.durationSeconds,
      location: summary.location,
      timeOfDay: summary.timeOfDay,
    })),
    analysisModel: trim(input.analysisModel),
  };
}

type LegacyMusicHashKind = 'v5' | 'v5-titled' | 'v4';

function legacyMusicPromptHashBody(
  shotSummaries: readonly LegacyMusicShotSummary[],
  analysisModel: string,
  kind: LegacyMusicHashKind
): unknown {
  return {
    artifact: 'sequence:music-prompt',
    hashVersion: kind === 'v4' ? 4 : PROMPT_INPUT_HASH_VERSION,
    sceneSummaries: shotSummaries.map((summary) =>
      kind === 'v5'
        ? {
            sceneId: summary.sceneId,
            storyBeat: summary.storyBeat,
            durationSeconds: summary.durationSeconds,
            location: summary.location,
            timeOfDay: summary.timeOfDay,
            visualSummary: summary.visualSummary,
          }
        : summary
    ),
    analysisModel: trim(analysisModel),
  };
}

const musicPromptInputHashInputSchema = z.object({
  sceneSummaries: z.array(z.unknown()),
  analysisModel: z.string(),
});

export function computeMusicPromptInputHash(
  raw: MusicPromptInputHashInput
): Promise<MusicPromptInputHash> {
  musicPromptInputHashInputSchema.parse(raw);
  return sha256Hex(musicPromptHashBody(raw)).then(musicPromptInputHash);
}

/** Pre-#1783 digest. Verify/tests only — delete after {@link LEGACY_HASH_UNTIL}. */
export function computeLegacyMusicPromptInputHash(
  shotSummaries: readonly LegacyMusicShotSummary[],
  analysisModel: string,
  kind: LegacyMusicHashKind
): Promise<string> {
  return sha256Hex(
    legacyMusicPromptHashBody(shotSummaries, analysisModel, kind)
  );
}

/**
 * `legacyShotSummaries` is the same sequence in the pre-#1783 per-shot shape,
 * so a prompt stamped by a regenerate before deploy still reads fresh. The
 * pipeline's own pre-#1783 stamps never matched any verify and stay stale.
 */
export async function musicPromptInputHashMatches(
  stored: string | null,
  raw: MusicPromptInputHashInput,
  legacyShotSummaries: readonly LegacyMusicShotSummary[]
): Promise<boolean> {
  if (!stored) return false;
  musicPromptInputHashInputSchema.parse(raw);
  const digests = await Promise.all([
    sha256Hex(musicPromptHashBody(raw)),
    ...(['v5', 'v5-titled', 'v4'] as const).map((kind) =>
      computeLegacyMusicPromptInputHash(
        legacyShotSummaries,
        raw.analysisModel,
        kind
      )
    ),
  ]);
  return digests.includes(stored);
}

export type SequenceMusicHashInput = {
  prompt: string;
  /** Tag string (comma-joined, as stored on `sequences.musicTags`). */
  tags: string;
  durationSeconds: number;
  audioModel: string;
};

const sequenceMusicHashInputSchema = z.object({
  prompt: z.string(),
  tags: z.string(),
  durationSeconds: z.number(),
  audioModel: z.string(),
});

export function computeSequenceMusicInputHash(
  raw: SequenceMusicHashInput
): Promise<SequenceMusicInputHash> {
  const input = sequenceMusicHashInputSchema.parse(raw);
  return sha256Hex({
    artifact: 'sequence:music',
    prompt: trim(input.prompt),
    tags: trim(input.tags),
    durationSeconds: input.durationSeconds,
    audioModel: input.audioModel,
  }).then(sequenceMusicInputHash);
}
