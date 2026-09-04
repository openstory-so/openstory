/**
 * Snapshot DTO hashers for content-generation workflows that opt into the
 * snapshot pattern.
 *
 * The `compute*FromDto` helpers hash the inlined payload; `compute*Current`
 * helpers re-resolve the upstream inputs from the live scoped DB so the
 * workflow can detect divergence at write-time.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Per-workflow input surface".
 */

import {
  characterSheetInputHashMatches,
  computeCharacterSheetInputHash,
  computeLibraryLocationReferenceInputHash,
  computeShotImageInputHash,
  computeLocationSheetInputHash,
  computeTalentSheetInputHash,
  locationSheetInputHashMatches,
  sha256Hex,
  type CharacterBibleHashFields,
  type ShotImageHashInput,
  type LocationBibleHashFields,
} from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { styleConfigHashBody } from '@/lib/style/style-config';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
  StyleConfig,
} from '@/lib/db/schema';
import type {
  CharacterSheetWorkflowInput,
  ShotImageSceneSnapshot,
  ShotImagesWorkflowInput,
  LibraryLocationSheetWorkflowInput,
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToShotImage,
  matchElementsToShotImage,
  matchLocationsToScene,
} from './scene-matching';

export type { ShotImageSceneSnapshot } from '@/lib/workflow/types';

/**
 * The live reads the `*Current` divergence-recompute helpers make. Narrowed so
 * a workflow hands over `scopedDb.liveRead`: recomputing an input hash from
 * CURRENT state is the point of these functions — freezing the inputs would
 * make divergence unrepresentable — and this type is what marks that at the
 * boundary. The trigger-side `*FromDto` twins take no db at all.
 */
export type SheetSnapshotReadDb = {
  characters: Pick<ScopedDb['characters'], 'getById'>;
  talent: Pick<ScopedDb['talent'], 'getWithRelations'>;
  locations: Pick<ScopedDb['locations'], 'getById'>;
  sequenceLocations: Pick<ScopedDb['sequenceLocations'], 'getById'>;
};

/**
 * Resolve the upstream talent-sheet's `input_hash` for a sequence character.
 * Returns `null` when the character has no talent assignment, when the talent
 * has no sheets, or when the sheet predates hash tracking.
 */
async function resolveTalentSheetHash(
  scopedDb: SheetSnapshotReadDb,
  characterDbId: string
): Promise<string | null> {
  const character = await scopedDb.characters.getById(characterDbId);
  if (!character?.talentId) return null;
  const talent = await scopedDb.talent.getWithRelations(character.talentId);
  // Exclude divergent sheets from the fallback identity. A divergent row's
  // `inputHash` represents the parked workflow's snapshot, not the talent's
  // current upstream identity — binding a downstream character sheet to it
  // would fork off a stale lineage from first-time generation onward.
  const convergentSheets = talent?.sheets.filter((s) => !s.divergedAt) ?? [];
  const defaultSheet =
    convergentSheets.find((s) => s.isDefault) ?? convergentSheets[0];
  return defaultSheet?.inputHash ?? null;
}

/**
 * Resolve the parent library-location's `reference_input_hash` for a sequence
 * location. Returns `null` when the sequence location has no library
 * reference, or when the library row predates hash tracking.
 */
async function resolveLibraryLocationReferenceHash(
  scopedDb: SheetSnapshotReadDb,
  locationDbId: string
): Promise<string | null> {
  const sequenceLocation =
    await scopedDb.sequenceLocations.getById(locationDbId);
  if (!sequenceLocation?.libraryLocationId) return null;
  const libraryLocation = await scopedDb.locations.getById(
    sequenceLocation.libraryLocationId
  );
  return libraryLocation?.referenceInputHash ?? null;
}

/** Hash a `StyleConfig` deterministically. `null`/`undefined` → 'no-style'. */
export async function computeStyleConfigHash(
  styleConfig: StyleConfig | null | undefined
): Promise<string> {
  if (!styleConfig) return 'no-style';
  // styleConfigHashBody keeps the legacy flat key names, so hashes stored
  // before the v2 reshape stay valid — see its doc comment.
  return sha256Hex({
    artifact: 'style-config',
    ...styleConfigHashBody(styleConfig),
  });
}

function characterBibleFields(
  metadata: CharacterSheetWorkflowInput['characterMetadata']
): CharacterBibleHashFields {
  return {
    name: metadata.name,
    age: metadata.age,
    gender: metadata.gender,
    ethnicity: metadata.ethnicity,
    physicalDescription: metadata.physicalDescription,
    standardClothing: metadata.standardClothing,
    distinguishingFeatures: metadata.distinguishingFeatures,
    consistencyTag: metadata.consistencyTag,
  };
}

/**
 * Hash the character-sheet workflow payload. The `talentSheetInputHash` field
 * inlines the upstream talent-sheet's `input_hash` so that a recast triggered
 * against a then-current talent sheet binds to that exact upstream version.
 */
function characterSheetHashInput(
  input: CharacterSheetWorkflowInput & { talentSheetInputHash?: string | null }
) {
  return {
    characterBible: characterBibleFields(input.characterMetadata),
    talentSheetHash: input.talentSheetInputHash ?? null,
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  };
}

export async function computeCharacterSheetHashFromDto(
  input: CharacterSheetWorkflowInput & { talentSheetInputHash?: string | null }
): Promise<string> {
  return computeCharacterSheetInputHash({
    ...characterSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

/** Dual-hash verify against a stored sheet digest. */
export async function characterSheetHashMatchesStored(
  stored: string | null,
  input: CharacterSheetWorkflowInput & { talentSheetInputHash?: string | null }
): Promise<boolean> {
  return characterSheetInputHashMatches(stored, {
    ...characterSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

/**
 * Recompute the hash from the current DB state. The character bible, style
 * config, and image model are frozen on the payload (they must not drift
 * mid-flight); we re-read the upstream talent sheet's `input_hash` since
 * that's the only upstream entity whose hash can change between trigger and
 * write.
 */
export async function computeCharacterSheetHashCurrent(
  input: CharacterSheetWorkflowInput,
  scopedDb: SheetSnapshotReadDb
): Promise<string> {
  const talentSheetInputHash = await resolveTalentSheetHash(
    scopedDb,
    input.characterDbId
  );
  return computeCharacterSheetHashFromDto({ ...input, talentSheetInputHash });
}

function locationBibleFields(
  metadata: LocationSheetWorkflowInput['locationMetadata']
): LocationBibleHashFields {
  return {
    name: metadata.name,
    description: metadata.description,
  };
}

/**
 * Hash the location-sheet workflow payload. `libraryLocationReferenceHash`
 * inlines the parent library location's `reference_input_hash` if the sheet
 * was triggered with a library reference; otherwise `null`.
 */
function locationSheetHashInput(
  input: LocationSheetWorkflowInput & {
    libraryLocationReferenceHash?: string | null;
  }
) {
  return {
    locationBible: locationBibleFields(input.locationMetadata),
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  };
}

export async function computeLocationSheetHashFromDto(
  input: LocationSheetWorkflowInput & {
    libraryLocationReferenceHash?: string | null;
  }
): Promise<string> {
  return computeLocationSheetInputHash({
    ...locationSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

/** Dual-hash verify against a stored location-sheet digest. */
export async function locationSheetHashMatchesStored(
  stored: string | null,
  input: LocationSheetWorkflowInput & {
    libraryLocationReferenceHash?: string | null;
  }
): Promise<boolean> {
  return locationSheetInputHashMatches(stored, {
    ...locationSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

export async function computeLocationSheetHashCurrent(
  input: LocationSheetWorkflowInput,
  scopedDb: SheetSnapshotReadDb
): Promise<string> {
  const libraryLocationReferenceHash =
    await resolveLibraryLocationReferenceHash(scopedDb, input.locationDbId);
  return computeLocationSheetHashFromDto({
    ...input,
    libraryLocationReferenceHash,
  });
}

/**
 * Library talent sheets are content-addressed by the inlined reference URLs:
 * talent media is append-only in practice, so the snapshot is the URL set
 * itself. Extra live URLs (photos dropped while a run is in flight) do not
 * diverge: `Current` hashes the snapshot set when it is a subset of live
 * media. We hash via `computeTalentSheetInputHash` keyed on those URLs as
 * the reference-media identity (no external `media_id` lookup required).
 */
export async function computeLibraryTalentSheetHashFromDto(
  input: LibraryTalentSheetWorkflowInput
): Promise<string> {
  // Sort here so callers that forget to pre-sort get a stable hash. The
  // `Current` helper sorts the live media URLs the same way; without sorting
  // here, an unsorted DTO would diverge against a sorted DB read on every run.
  const referenceMediaHashes = [...(input.referenceImageUrls ?? [])].sort();
  return computeTalentSheetInputHash({
    talent: {
      name: input.talentName,
      description: input.talentDescription ?? null,
    },
    referenceMediaHashes,
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

export async function computeLibraryTalentSheetHashCurrent(
  input: LibraryTalentSheetWorkflowInput,
  scopedDb: SheetSnapshotReadDb
): Promise<string> {
  const talent = await scopedDb.talent.getWithRelations(input.talentId);
  // Fall back to the payload when the talent row vanished mid-flight — the
  // workflow will fail downstream on the missing record, but we shouldn't mask
  // the divergence check with a noisy lookup error here. Description is
  // re-read because a mid-run rewrite is a real input change; the display
  // name is passed through but not hashed.
  const liveImageUrls =
    talent?.media
      .filter((m) => m.type === 'image')
      .map((m) => m.url)
      .sort() ??
    input.referenceImageUrls ??
    [];
  const snapshotUrls = input.referenceImageUrls ?? [];
  const liveSet = new Set(liveImageUrls);
  // Talent media is append-only. Extra live URLs must not park a generate-if-
  // missing run as divergent (two photo finalizes, or photos dropped while a
  // name-only sheet is in flight). Missing snapshot URLs still hash live.
  const snapshotSubsetOfLive = snapshotUrls.every((url) => liveSet.has(url));
  return computeLibraryTalentSheetHashFromDto({
    ...input,
    talentName: talent?.name ?? input.talentName,
    // `talent.description` cleared to null must hash as cleared, not fall back
    // to the payload — so the payload is only consulted when there's no row.
    talentDescription: talent
      ? (talent.description ?? undefined)
      : input.talentDescription,
    referenceImageUrls: snapshotSubsetOfLive ? snapshotUrls : liveImageUrls,
  });
}

/**
 * Library location references are content-addressed the same way the talent
 * twin is: the name/description the sheet was generated for, the inlined
 * reference URLs, and the model.
 */
export async function computeLibraryLocationSheetHashFromDto(
  input: LibraryLocationSheetWorkflowInput
): Promise<string> {
  return computeLibraryLocationReferenceInputHash({
    locationBible: {
      name: input.locationName,
      description: input.locationDescription ?? null,
    },
    // No style config on the library sheet payload — library references are
    // style-agnostic; the per-sequence location sheet applies the style.
    styleConfigHash: await computeStyleConfigHash(null),
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
    referenceMediaHashes: [...input.referenceImageUrls].sort(),
  });
}

/**
 * Recompute from live DB state. Only name/description are re-read: the
 * reference URL set is the run's frozen input (the payload composes it from
 * sheets + the prior reference), so re-deriving it here would manufacture
 * permanent divergence rather than detect it.
 */
export async function computeLibraryLocationSheetHashCurrent(
  input: LibraryLocationSheetWorkflowInput,
  scopedDb: SheetSnapshotReadDb
): Promise<string> {
  const location = await scopedDb.locations.getById(input.locationDbId);
  return computeLibraryLocationSheetHashFromDto({
    ...input,
    locationName: location?.name ?? input.locationName,
    locationDescription: location
      ? (location.description ?? undefined)
      : input.locationDescription,
  });
}

/** Drop nulls/empties and sort so order-insensitive comparisons match. */
function sortedRefHashes(values: Array<string | null | undefined>): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

/**
 * Match a scene's referenced characters / locations / elements from live DB
 * rows and resolve the three reference-hash sets that feed the shot-image
 * input hash: the selected sheet version id when present (so a new sheet
 * image re-stales stills even with identical bible inputs), else the parent
 * `sheetInputHash` / `referenceInputHash`; plus element `imageUrl`.
 *
 * Character and element matching use the still's visual prompt when
 * `visualPrompt` is passed (the same text the image model generated from)
 * so a regenerated prompt that names `SCARLETT` still attaches her sheet
 * when continuity tags are empty (#1432). Scene extract / `elementTags`
 * are the element fallback only when no prompt exists.
 *
 * Single source of truth so the image-generation trigger **stamp**
 * (`computeShotImageInputHash` via `prepareShotImageWorkflowInput`) and the staleness **verify**
 * (`buildRegenerateShotSnapshot`) cannot drift — drift on the element /
 * location sets (verify hard-coded them to `[]` and used a different location
 * matcher) made every element- or location-bearing shot report permanently
 * "Inputs changed". See #867.
 */
export function resolveSceneShotImageReferences(params: {
  // Structural (not `Scene`) so it accepts both the strict scene and the
  // looser `shot.metadata` shapes callers hold; only these fields are read.
  scene: {
    continuity?: {
      characterTags?: string[];
      environmentTag?: string;
      elementTags?: string[] | null;
    } | null;
    metadata?: { location?: string } | null;
    originalScript?: { extract?: string } | null;
  } | null;
  /**
   * The still's visual prompt. When present, element matching uses this
   * text (not scene extract / tags) so a replace only stales stills that
   * actually named the element. See `matchElementsToShotImage`.
   */
  visualPrompt?: string | null;
  characters: CharacterMinimal[];
  locations: SequenceLocationMinimal[];
  elements: SequenceElementMinimal[];
}): {
  characters: CharacterMinimal[];
  locations: SequenceLocationMinimal[];
  elements: SequenceElementMinimal[];
  characterSheetHashes: string[];
  locationSheetHashes: string[];
  elementReferenceHashes: string[];
} {
  const { scene, visualPrompt, characters, locations, elements } = params;
  const matchedCharacters = matchCharactersToShotImage(characters, {
    characterTags: scene?.continuity?.characterTags,
    visualPrompt,
  });
  const matchedLocations = matchLocationsToScene(
    locations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? '',
    scene?.originalScript?.extract
  );
  const matchedElements = matchElementsToShotImage(elements, {
    visualPrompt,
    elementTags: scene?.continuity?.elementTags,
    sceneExtract: scene?.originalScript?.extract,
  });
  return {
    characters: matchedCharacters,
    locations: matchedLocations,
    elements: matchedElements,
    characterSheetHashes: sortedRefHashes(
      matchedCharacters.map((c) => c.selectedSheetVersionId ?? c.sheetInputHash)
    ),
    locationSheetHashes: sortedRefHashes(
      matchedLocations.map(
        (l) => l.selectedReferenceVersionId ?? l.referenceInputHash
      )
    ),
    elementReferenceHashes: sortedRefHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };
}

/**
 * Hash one scene's snapshot — used to populate `thumbnail_input_hash` on the
 * shot row and `input_hash` on the matching primary `shot_variants` row.
 */
export function computeShotImageSceneHash(
  scene: ShotImageSceneSnapshot,
  imageModel: string,
  aspectRatio: string
): Promise<string> {
  const hashInput: ShotImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: scene.visualPrompt,
    imageModel,
    aspectRatio,
    characterSheetHashes: scene.characterSheetHashes,
    locationSheetHashes: scene.locationSheetHashes,
    elementReferenceHashes: scene.elementReferenceHashes,
  };
  return computeShotImageInputHash(hashInput);
}

/**
 * Hash the full shot-images payload. Binds every scene snapshot — including
 * the upstream sheet hashes alongside each URL — so a payload that preserves
 * only `snapshotInputHash` cannot smuggle replaced reference images past
 * validation.
 */
export async function computeShotImagesHashFromDto(
  input: ShotImagesWorkflowInput & {
    sceneSnapshots: ShotImageSceneSnapshot[];
  }
): Promise<string> {
  return sha256Hex({
    artifact: 'shot-images:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    imageModels: input.imageModels ?? null,
    aspectRatio: input.aspectRatio,
    scenes: [...input.sceneSnapshots].sort((a, b) =>
      a.sceneId.localeCompare(b.sceneId)
    ),
  });
}
