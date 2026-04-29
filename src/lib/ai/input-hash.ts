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
 * optional fields to `null` before passing in.
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

type FrameImageHashFields = {
  visualPrompt: string;
  imageModel: string;
  aspectRatio: string;
  size?: string | null;
  seed?: number | null;
  characterSheetHashes: readonly string[];
  locationSheetHashes: readonly string[];
  elementReferenceHashes: readonly string[];
};

export type FrameImageHashKind = 'thumbnail' | 'variant-image';

export type FrameImageHashInput = FrameImageHashFields & {
  kind: FrameImageHashKind;
};

export function computeFrameImageInputHash(
  input: FrameImageHashInput
): Promise<string> {
  return sha256Hex({
    artifact: `frame:${input.kind}`,
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
export type FrameVideoSourceImage =
  | { kind: 'variantHash'; hash: string }
  | { kind: 'url'; url: string };

export type FrameVideoHashInput = {
  sourceImage: FrameVideoSourceImage;
  motionPrompt: string;
  motionModel: string;
  durationSeconds: number;
  fps?: number | null;
  aspectRatio: string;
};

export function computeFrameVideoInputHash(
  input: FrameVideoHashInput
): Promise<string> {
  const sourceImage =
    input.sourceImage.kind === 'variantHash'
      ? { kind: 'variantHash' as const, hash: trim(input.sourceImage.hash) }
      : { kind: 'url' as const, url: trim(input.sourceImage.url) };
  return sha256Hex({
    artifact: 'frame:video',
    sourceImage,
    motionPrompt: trim(input.motionPrompt),
    motionModel: input.motionModel,
    durationSeconds: input.durationSeconds,
    fps: input.fps ?? null,
    aspectRatio: input.aspectRatio,
  });
}

export type FrameAudioHashInput = {
  musicPrompt: string;
  /** Unordered set of music tags. */
  tags: readonly string[];
  durationSeconds: number;
  audioModel: string;
};

export function computeFrameAudioInputHash(
  input: FrameAudioHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'frame:audio',
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
