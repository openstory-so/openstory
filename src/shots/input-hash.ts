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

import { wornStyling } from '@/cast/bible-looks';
import { z } from 'zod';

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
});

export function computeShotImageInputHash(
  raw: ShotImageHashInput
): Promise<ShotImageInputHash> {
  const input = shotImageHashInputSchema.parse(raw);
  return sha256Hex({
    artifact: `shot:${input.kind}`,
    visualPrompt: trim(input.visualPrompt),
    imageModel: input.imageModel,
    aspectRatio: input.aspectRatio,
    size: input.size,
    seed: input.seed,
    characterSheetHashes: sortedRefs(input.characterSheetHashes),
    locationSheetHashes: sortedRefs(input.locationSheetHashes),
    elementReferenceHashes: sortedRefs(input.elementReferenceHashes),
  }).then(shotImageInputHash);
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
  rendering: string | null;
  consistencyTag: string | null;
  /** Not hashed — BytePlus registration only (#1682). */
  isPerson?: boolean;
};

/**
 * What a digest stamped before #2065 hashed where the current one hashes the
 * effective styling: the look's OWN stored styling, and the features text
 * its character's bible version still holds. Verify only, read from the
 * stored rows (`legacyStylingParts`) — never from a payload, and never
 * stamped. Delete with {@link LEGACY_HASH_UNTIL}.
 */
export type LegacyStylingParts = {
  /** `character_bible_versions.legacyDistinguishingFeatures`. */
  distinguishingFeatures: string | null;
  /** The look version's own `styling` column. */
  styling: string | null;
};

/** {@link LegacyStylingParts} of each entry of a prompt's cast, by `characterId`. */
export type LegacyStylingByCharacter = Readonly<
  Record<string, LegacyStylingParts>
>;

/**
 * What the character-sheet prompt reads from a cast talent (#1785), resolved
 * live by `resolveCastTalent`. `description` is the talent row's own text, not
 * the path-specific prompt wording built from it, so every stamp path hashes
 * what verify recomputes. `sheetImageUrl` / `sheetLook` are the default talent
 * sheet the prompt copies — a promoted variant keeps its sheet's `inputHash`
 * but changes the image.
 */
const characterSheetTalentHashFieldsSchema = z.object({
  description: z.string().nullable(),
  sheetImageUrl: z.string().nullable(),
  /** Required; `null` is "the talent sheet has no look metadata". */
  sheetLook: z
    .object({
      age: z.string().nullable(),
      gender: z.string().nullable(),
      ethnicity: z.string().nullable(),
      physicalDescription: z.string().nullable(),
    })
    .nullable(),
});
export type CharacterSheetTalentHashFields = z.infer<
  typeof characterSheetTalentHashFieldsSchema
>;

export type CharacterSheetHashInput = {
  /**
   * `standardClothing` is the look's clothing (#2015). The key and its place
   * in the body are the bible's old ones, so a default look backfilled from
   * the bible hashes to the digest its sheet was stamped with.
   */
  characterBible: CharacterBibleHashFields;
  /**
   * The look's hair / makeup / injury notes (#2015), as `effectiveStyling`
   * resolves them (#2065). Required; `null` is "none". Joins the body only
   * when set, so no digest stamped before looks moves.
   */
  styling: string | null;
  /**
   * The default look's sheet version, when this look is drawn from it
   * (#2015): the selected version, or that look's id when the pointer is
   * still null (the #1419 row). Null on the default look, and on a look whose
   * default has no sheet yet. Joins every digest shape
   * once set, so a look sheet drawn from a description does not stay fresh
   * after the default sheet exists.
   */
  faceSheetVersionId: string | null;
  /** Required; `null` is "no talent sheet". */
  talentSheetHash: string | null;
  /** Required; `null` is "not cast". */
  talent: CharacterSheetTalentHashFields | null;
  /**
   * The sequence style's digest. Read only by the legacy shapes (a sheet
   * read the style before `rendering`, #2017): null skips them, for a
   * check with no sequence in view.
   */
  styleConfigHash: string | null;
  imageModel: string;
};

/**
 * Sheet digest shapes. `current` hashes the bible's `rendering` and no
 * style (#2017); `pre-rendering` is that body with the sequence style's
 * digest instead; `pre-2065` is the same with the bible's features under
 * their own key and the look's own styling; `pre-1785` is that digest
 * without the talent channel; `named` is the pre-#1108 digest. Verify
 * accepts the legacy four until {@link LEGACY_HASH_UNTIL}.
 */
type SheetHashKind =
  | 'current'
  | 'pre-rendering'
  | 'pre-2065'
  | 'pre-1785'
  | 'named';
const LEGACY_SHEET_HASH_KINDS = [
  'pre-rendering',
  'pre-2065',
  'pre-1785',
  'named',
] as const;
type LocationSheetHashKind = Exclude<
  SheetHashKind,
  'pre-2065' | 'pre-rendering'
>;

/** `legacy` is required for every kind but `current`, which never reads it. */
function characterSheetHashBody(
  input: CharacterSheetHashInput,
  kind: SheetHashKind,
  legacy: LegacyStylingParts | null
): unknown {
  const cb = input.characterBible;
  const talent =
    kind === 'current' || kind === 'pre-rendering' || kind === 'pre-2065'
      ? input.talent
      : null;
  // `pre-rendering` is the current body with the style: effective styling,
  // so no legacy parts.
  if (kind !== 'current' && kind !== 'pre-rendering' && legacy === null) {
    throw new Error(`input-hash: the ${kind} sheet digest needs legacy parts`);
  }
  if (kind !== 'current' && input.styleConfigHash === null) {
    throw new Error(`input-hash: the ${kind} sheet digest needs the style`);
  }
  // Every shape: a legacy digest predates looks, so it was stamped with no
  // styling, and dropping it there would let a styling edit verify as fresh
  // against the pre-#1785 shape of an uncast sheet.
  const styling = trim(legacy === null ? input.styling : legacy.styling);
  // Every shape, same as styling: a legacy digest that omitted the face
  // must not verify a look once the default sheet's version is known.
  const faceSheetVersionId = trim(input.faceSheetVersionId);
  return {
    artifact: 'character:sheet',
    ...(styling ? { styling } : {}),
    ...(faceSheetVersionId ? { faceSheetVersionId } : {}),
    characterBible: {
      ...(kind === 'named' ? { name: trim(cb.name) } : {}),
      age: trim(cb.age),
      gender: trim(cb.gender),
      ethnicity: trim(cb.ethnicity),
      physicalDescription: trim(cb.physicalDescription),
      standardClothing: trim(cb.standardClothing),
      ...(legacy === null
        ? {}
        : { distinguishingFeatures: trim(legacy.distinguishingFeatures) }),
      // What the character is rendered as (#2017): in the sheet instead of
      // the sequence style, so every sequence hashes the shared sheet alike.
      ...(kind === 'current' ? { rendering: trim(cb.rendering) } : {}),
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
    ...(kind === 'current' ? {} : { styleConfigHash: input.styleConfigHash }),
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
  rendering: z.string().nullable(),
  consistencyTag: z.string().nullable(),
});

/**
 * The fields the sheet hash reads; a bible edit to one revokes every look's
 * sheet claim. `standardClothing` is the look's (#2015) and moves only
 * through a look edit, which revokes that look's claim itself.
 */
export const CHARACTER_SHEET_BIBLE_FIELDS =
  characterBibleHashFieldsSchema.keyof().options;

const characterSheetHashInputSchema = z.object({
  characterBible: characterBibleHashFieldsSchema,
  styling: z.string().nullable(),
  faceSheetVersionId: z.string().nullable(),
  talentSheetHash: z.string().nullable(),
  talent: characterSheetTalentHashFieldsSchema.nullable(),
  styleConfigHash: z.string().nullable(),
  imageModel: z.string(),
});

export function computeCharacterSheetInputHash(
  raw: CharacterSheetHashInput
): Promise<CharacterSheetInputHash> {
  const input = characterSheetHashInputSchema.parse(raw);
  return sha256Hex(characterSheetHashBody(input, 'current', null)).then(
    characterSheetInputHash
  );
}

/**
 * A legacy sheet digest (`pre-2065` by default). Verify/tests only — delete
 * after {@link LEGACY_HASH_UNTIL}.
 */
export function computeCharacterSheetInputHashLegacy(
  raw: CharacterSheetHashInput,
  legacy: LegacyStylingParts,
  kind: Exclude<SheetHashKind, 'current'> = 'named'
): Promise<string> {
  const input = characterSheetHashInputSchema.parse(raw);
  return sha256Hex(characterSheetHashBody(input, kind, legacy));
}

/**
 * Verify: the current digest, or a legacy one. `legacy` is the look's stored
 * parts, required so no verify site can forget the shapes every sheet made
 * before #2065 was stamped in. With no style digest only the current shape
 * is checked: a sheet stamped before `rendering` then reads stale, which is
 * right for a check made with no sequence in view.
 */
export async function characterSheetInputHashMatches(
  stored: string | null,
  raw: CharacterSheetHashInput,
  legacy: LegacyStylingParts
): Promise<boolean> {
  if (!stored) return false;
  const input = characterSheetHashInputSchema.parse(raw);
  const digests = await Promise.all([
    sha256Hex(characterSheetHashBody(input, 'current', null)),
    ...(input.styleConfigHash === null
      ? []
      : LEGACY_SHEET_HASH_KINDS.map((kind) =>
          sha256Hex(characterSheetHashBody(input, kind, legacy))
        )),
  ]);
  return digests.includes(stored);
}

const locationBibleHashFieldsSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
});
type LocationBibleHashFields = z.infer<typeof locationBibleHashFieldsSchema>;

/**
 * Every bible field the location-sheet prompt reads (#1785). `name` is a
 * label, hashed only by the pre-#1108 digest.
 */
const locationSheetBibleHashFieldsSchema = locationBibleHashFieldsSchema.extend(
  {
    type: z.enum(['interior', 'exterior', 'both']),
    architecturalStyle: z.string(),
    keyFeatures: z.string(),
    ambiance: z.string(),
  }
);
/** The location bible fields the sheet hash reads; an edit to one revokes a sheet claim. */
export const LOCATION_SHEET_BIBLE_FIELDS =
  locationSheetBibleHashFieldsSchema.keyof().options;
export type LocationSheetBibleHashFields = z.infer<
  typeof locationSheetBibleHashFieldsSchema
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
  kind: LocationSheetHashKind
): unknown {
  const lb = input.locationBible;
  return {
    artifact: 'location:sheet',
    version: 2, // #1889: neutral place; scene light and style palette have new owners.
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

const locationSheetHashInputSchema = z.object({
  locationBible: locationSheetBibleHashFieldsSchema,
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
import {
  canonicalStoredShotSpec,
  type StoredShotSpec,
} from '@/shots/shot-list.schema';

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
  /**
   * The shot's selected spec (#1923). Omitted or null leaves the digest
   * unchanged, so a stamp from before specs still matches. Present, it is
   * hashed by content: derivation is a pure function of that content.
   */
  spec?: StoredShotSpec | null;
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
function sceneWithShotDialogue(scene: Scene, dialogue: MotionDialogue): Scene {
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
  // The hash assembler only. The LLM schema is `storedShotSpecSchema`.
  spec: z
    .custom<StoredShotSpec>(
      (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
    )
    .nullable()
    .optional(),
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
  spec?: StoredShotSpec | null;
  /** Verify only: read by every kind but `current` (#2065). */
  legacyStyling?: LegacyStylingByCharacter;
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
    spec: input.spec,
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
 * Delete every legacy verify fallback after this date: v4 / named / titled,
 * and the pre-#2065, pre-#1785, pre-#1784 and pre-#1783 shapes. The
 * `distinguishing_features` column the pre-#2065 shape reads is backfilled
 * into the default looks and dropped in the same change.
 * Tracking: https://github.com/openstory-so/openstory/issues/1371
 */
// Milestone 24 (#1783–#1787, #1827) added fallbacks under this date; they
// need ~a month after that stack deploys, or everything stamped before it flips stale.
export const LEGACY_HASH_UNTIL = '2026-12-31';

/**
 * Older prompt shapes. Verify accepts these until {@link LEGACY_HASH_UNTIL}.
 * `pre-2065` is the current shape before the default look took the bible's
 * features (#2065): the same body, with each character's features under
 * their own key and the worn look's own styling. `v5-voiced` is that shape
 * before #1785 took voice-only characters out of the visual body and #1787
 * marked them in the motion body; the older legacy shapes predate that too.
 */
type PromptHashKind =
  | 'current'
  | 'pre-2065'
  | 'v5-voiced'
  | 'v5-titled'
  | 'v5-named'
  | 'v4';

function promptHashFlags(kind: PromptHashKind) {
  // `pre-2065` differs from `current` only in how a character is projected.
  const latest = kind === 'current' || kind === 'pre-2065';
  return {
    hashVersion:
      kind === 'v4' ? PROMPT_INPUT_HASH_VERSION_V4 : PROMPT_INPUT_HASH_VERSION,
    named: kind === 'v4' || kind === 'v5-named',
    includeTitle: !latest && kind !== 'v5-voiced',
    includeSceneNumber: kind === 'v4',
    keepVoiceOnly: !latest,
    /** Reads the spec, and not the still (#1923). */
    latest,
    legacyStyling: kind !== 'current',
  };
}

function sceneInputContext(scene: Scene, kind: PromptHashKind) {
  const flags = promptHashFlags(kind);
  return {
    ...(flags.includeSceneNumber ? { sceneNumber: scene.sceneNumber } : {}),
    originalScript: scene.originalScript,
    metadata: sceneMetadata(scene, flags.includeTitle),
    ...(scene.continuity?.lightingSetup
      ? { lightingSetup: scene.continuity.lightingSetup }
      : {}),
    ...(scene.continuity?.colorPalette
      ? { colorPalette: scene.continuity.colorPalette }
      : {}),
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
function projectCharacterForPrompt(
  c: CharacterBibleEntry,
  legacy: LegacyStylingParts | null
) {
  // The look the shot's scene dresses the character in (#2015): its clothing
  // is `standardClothing`, and its styling joins only when set, so no digest
  // stamped before looks moves. The other looks are not this shot's.
  // A digest from before #2065 hashed the look's own styling and the bible's
  // features under their own key; the current one hashes the effective
  // styling, which holds both.
  const styling = trim(legacy === null ? wornStyling(c) : legacy.styling);
  return {
    ...(styling ? { styling } : {}),
    age: trim(c.age),
    gender: trim(c.gender),
    ethnicity: trim(c.ethnicity),
    physicalDescription: trim(c.physicalDescription),
    standardClothing: trim(c.standardClothing),
    ...(legacy === null
      ? {}
      : { distinguishingFeatures: trim(legacy.distinguishingFeatures) }),
  };
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
    description: trim(l.description),
    architecturalStyle: trim(l.architecturalStyle),
    keyFeatures: trim(l.keyFeatures),
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
  {
    named,
    performance,
    legacyStyling,
    markVoiceOnly = false,
  }: {
    named: boolean;
    performance: boolean;
    legacyStyling: boolean;
    markVoiceOnly?: boolean;
  }
) {
  const bibles = sortedBibles(input);
  const legacyOf = (c: CharacterBibleEntry): LegacyStylingParts | null => {
    if (!legacyStyling) return null;
    const parts = input.legacyStyling?.[c.characterId];
    if (!parts) {
      throw new Error(
        `input-hash: no legacy styling parts for character ${c.characterId}`
      );
    }
    return parts;
  };
  const character = (c: CharacterBibleEntry) => ({
    ...(named ? { name: trim(c.name) } : {}),
    ...projectCharacterForPrompt(c, legacyOf(c)),
  });
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
      ? bibles.elementBible.map(projectElementForPrompt)
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
    {
      named: flags.named,
      performance: false,
      legacyStyling: flags.legacyStyling,
    }
  );
  return {
    artifact: 'shot:visual-prompt',
    hashVersion: flags.hashVersion,
    scene: sceneInputContext(input.scene, kind),
    styleConfig: styleConfigHashBody(input.styleConfig),
    ...bibles,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
    // Content, and only on the current stamp. A legacy digest has no spec,
    // so a part-1 stamp stays fresh until the selected spec changes (#1923).
    ...(flags.latest && input.spec
      ? { spec: canonicalStoredShotSpec(input.spec) }
      : {}),
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
    legacyStyling: flags.legacyStyling,
    markVoiceOnly: !flags.keepVoiceOnly,
  });
  return {
    artifact: 'shot:motion-prompt',
    hashVersion: flags.hashVersion,
    scene: sceneInputContext(input.scene, kind),
    styleConfig: styleConfigHashBody(input.styleConfig),
    ...bibles,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
    // The current stamp is the derived prompt: it does not read the still.
    // Legacy kinds keep the URL so an old LLM stamp still matches until the
    // still it was written against changes (#1923).
    ...(flags.latest
      ? {}
      : { startingFrameImageUrl: trim(input.startingFrameImageUrl) }),
    ...(flags.latest && input.spec
      ? { spec: canonicalStoredShotSpec(input.spec) }
      : {}),
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

/**
 * A legacy visual digest (v4 by default). Verify/tests only — delete after
 * {@link LEGACY_HASH_UNTIL}.
 */
export async function computeVisualPromptInputHashV4(
  raw: VisualPromptHashInput | MotionPromptHashInput,
  legacyStyling: LegacyStylingByCharacter,
  kind: Exclude<PromptHashKind, 'current'> = 'v4'
): Promise<string> {
  const input = assembleVisualPromptHashInput(raw);
  return sha256Hex(
    visualPromptHashBody({ ...toVisualBodyInput(input), legacyStyling }, kind)
  );
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
 * Every shape before `pre-2065` ignores the voice-only flag, so such a
 * legacy digest is trusted only while no flag moved since the stamp —
 * otherwise it would equal the stamp and hide the change (#1787). Those
 * shapes have no spec either, so `acceptLegacy` false drops them too.
 * `pre-2065` reads both, like the current shape, and is always accepted.
 */
function acceptedKinds(opts: {
  voiceOnlyMoved: boolean;
  acceptLegacy: boolean;
}): readonly PromptHashKind[] {
  return opts.voiceOnlyMoved || !opts.acceptLegacy
    ? ['current', 'pre-2065']
    : ['current', 'pre-2065', 'v5-voiced', 'v5-titled', 'v5-named', 'v4'];
}

/**
 * True if `stored` matches the current digest or a legacy digest of the same
 * inputs. Remove the legacy kinds after {@link LEGACY_HASH_UNTIL}.
 * `voiceOnlyMoved`: {@link voiceOnlyMovedSince} the stamp. `legacyStyling`:
 * the stored parts of each character in `raw.characterBible` (#2065),
 * required so no verify site can forget the shape every prompt written
 * before #2065 was stamped in.
 */
export async function visualPromptInputHashMatches(
  stored: string | null,
  raw: VisualPromptHashInput | MotionPromptHashInput,
  {
    voiceOnlyMoved,
    legacyStyling,
    acceptLegacy = true,
  }: {
    voiceOnlyMoved: boolean;
    legacyStyling: LegacyStylingByCharacter;
    acceptLegacy?: boolean;
  }
): Promise<boolean> {
  if (!stored) return false;
  const input = {
    ...toVisualBodyInput(assembleVisualPromptHashInput(raw)),
    legacyStyling,
  };
  // A prompt built from an older spec must not hide behind a pre-spec digest.
  const kinds = acceptedKinds({ voiceOnlyMoved, acceptLegacy });
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

/**
 * A legacy motion digest (v4 by default). Verify/tests only — delete after
 * {@link LEGACY_HASH_UNTIL}.
 */
export async function computeMotionPromptInputHashV4(
  raw: MotionPromptHashInput,
  legacyStyling: LegacyStylingByCharacter,
  kind: Exclude<PromptHashKind, 'current'> = 'v4'
): Promise<string> {
  const input = assembleMotionPromptHashInput(raw);
  return sha256Hex(
    motionPromptHashBody({ ...toMotionBodyInput(input), legacyStyling }, kind)
  );
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
    legacyStyling,
    acceptLegacy = true,
  }: {
    legacyScriptDialogue: boolean;
    voiceOnlyMoved: boolean;
    /** As for the visual verify (#2065). */
    legacyStyling: LegacyStylingByCharacter;
    acceptLegacy?: boolean;
  }
): Promise<boolean> {
  if (!stored) return false;
  const assembled = assembleMotionPromptHashInput(raw);
  const inputs = (
    legacyScriptDialogue
      ? [toMotionBodyInput(assembled), toMotionBodyInput(assembled, true)]
      : [toMotionBodyInput(assembled)]
  ).map((input) => ({ ...input, legacyStyling }));
  const kinds = acceptedKinds({ voiceOnlyMoved, acceptLegacy });
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
