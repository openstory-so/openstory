/**
 * Snapshot DTO hashers for content-generation workflows that opt into the
 * snapshot pattern.
 *
 * The `compute*FromDto` helpers hash the inlined payload. Mid-run divergence
 * is not detected by re-hashing live state: the sheet workflows land through
 * a claim that every input edit revokes (#1113).
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
  type CharacterSheetInputHash,
  type CharacterSheetTalentHashFields,
  type LibraryLocationReferenceInputHash,
  type LocationSheetBibleHashFields,
  type LocationSheetInputHash,
  type ShotImageHashInput,
  type ShotImageInputHash,
  type TalentSheetInputHash,
} from '@/shots/input-hash';
import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import { styleConfigHashBody } from '@/look/style-config';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
  StyleConfig,
} from '@/platform/server/db/schema';
import type {
  CharacterSheetWorkflowInput,
  ShotImageSceneSnapshot,
  ShotImagesWorkflowInput,
  LibraryLocationSheetWorkflowInput,
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
  StillHashInput,
} from '@/platform/server/workflow/types';
import {
  matchCharactersToShotImage,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/shots/scene-matching';

export type { ShotImageSceneSnapshot } from '@/platform/server/workflow/types';

/**
 * A sheet payload before its trigger stamps the hash and takes the claim
 * (#1113): what the hashers read.
 */
export type SheetPayload<T> = Omit<
  T,
  | 'sheetVersionId'
  | 'referenceVersionId'
  | 'sheetId'
  | 'referenceClaimId'
  | 'snapshotInputHash'
>;

/**
 * A run queued, or a step result cached, before character looks shipped
 * (#2015) names no look. It is failed here, once, at the top of the run —
 * never patched up field by field further down.
 */
export function assertQueuedWithLooks(
  ...carriers: readonly { lookId?: unknown }[]
): void {
  if (carriers.some((carrier) => typeof carrier.lookId !== 'string')) {
    throw queuedBeforeLooks();
  }
}

/** The failure `assertQueuedWithLooks` raises, for a check of another shape. */
export const queuedBeforeLooks = () =>
  new WorkflowValidationError(
    'Queued before character looks shipped. Run it again.'
  );

/**
 * An analysis payload queued before the trigger snapshotted the cast (#2050):
 * the one check, at the top of the run, so no step defaults it.
 */
export const queuedBeforeCast = () =>
  new WorkflowValidationError(
    'Queued before character references shipped. Run it again.'
  );

/**
 * A sheet payload queued before every look carried `face` (#2015): the one
 * check, at the top of the run, so no field below defaults it.
 */
export function assertQueuedWithFace(input: object): void {
  if (!('face' in input)) {
    throw new WorkflowValidationError(
      'Queued before looks were drawn from the default look. Run it again.'
    );
  }
}

/**
 * A character sheet payload before its face: everything the trigger
 * snapshots except the default look's sheet and the hash that covers it.
 * A look whose default sheet the same run makes waits in this shape.
 */
export type CharacterSheetDraft = Omit<
  SheetPayload<CharacterSheetWorkflowInput>,
  'face'
>;

/** Give a draft its face and stamp the hash, which covers the face. */
export async function finishCharacterSheetPayload(
  draft: CharacterSheetDraft,
  face: CharacterSheetWorkflowInput['face']
): Promise<Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>> {
  const fields = { ...draft, face };
  return {
    ...fields,
    snapshotInputHash: await computeCharacterSheetHashFromDto(fields),
  };
}

/** The payload fields a cast talent supplies to a character sheet. */
export type CastTalentFields = Pick<
  CharacterSheetWorkflowInput,
  | 'referenceImageUrl'
  | 'talentMetadata'
  | 'talentSheetInputHash'
  | 'castTalentDescription'
>;

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
 * The cast-talent channel of the sheet hash (#1785): what the prompt reads
 * from the talent, keyed on the talent's own description rather than the
 * prompt wording each path builds from it. `null` when not cast.
 */
export function characterSheetTalentHashFields(
  input: CastTalentFields
): CharacterSheetTalentHashFields | null {
  const meta = input.talentMetadata;
  if (!input.referenceImageUrl && !meta && !input.castTalentDescription) {
    return null;
  }
  return {
    // `?? null`: a payload queued before #1785 has no such field.
    description: input.castTalentDescription ?? null,
    sheetImageUrl: input.referenceImageUrl ?? null,
    sheetLook: meta
      ? {
          age: meta.age,
          gender: meta.gender,
          ethnicity: meta.ethnicity,
          physicalDescription: meta.physicalDescription,
        }
      : null,
  };
}

/**
 * Hash the character-sheet workflow payload. The `talentSheetInputHash` field
 * inlines the upstream talent-sheet's `input_hash` so that a recast triggered
 * against a then-current talent sheet binds to that exact upstream version.
 */
function characterSheetHashInput(
  input: SheetPayload<CharacterSheetWorkflowInput>
) {
  return {
    characterBible: characterBibleFields(input.characterMetadata),
    styling: input.lookStyling,
    faceSheetVersionId: input.face === null ? null : input.face.versionId,
    talentSheetHash: input.talentSheetInputHash ?? null,
    talent: characterSheetTalentHashFields(input),
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  };
}

export async function computeCharacterSheetHashFromDto(
  input: SheetPayload<CharacterSheetWorkflowInput>
): Promise<CharacterSheetInputHash> {
  return computeCharacterSheetInputHash({
    ...characterSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

/** Dual-hash verify against a stored sheet digest. */
export async function characterSheetHashMatchesStored(
  stored: string | null,
  input: SheetPayload<CharacterSheetWorkflowInput>
): Promise<boolean> {
  return characterSheetInputHashMatches(stored, {
    ...characterSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

/** Every bible field the location-sheet prompt reads (#1785). */
export function locationSheetBibleFields(
  metadata: LocationSheetWorkflowInput['locationMetadata']
): LocationSheetBibleHashFields {
  return {
    name: metadata.name,
    type: metadata.type,
    description: metadata.description,
    architecturalStyle: metadata.architecturalStyle,
    keyFeatures: metadata.keyFeatures,
    ambiance: metadata.ambiance,
  };
}

/**
 * Hash the location-sheet workflow payload. `libraryLocationReferenceHash`
 * inlines the parent library location's `reference_input_hash` if the sheet
 * was triggered with a library reference; otherwise `null`.
 */
function locationSheetHashInput(
  input: SheetPayload<LocationSheetWorkflowInput> & {
    libraryLocationReferenceHash?: string | null;
  }
) {
  return {
    locationBible: locationSheetBibleFields(input.locationMetadata),
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  };
}

export async function computeLocationSheetHashFromDto(
  input: SheetPayload<LocationSheetWorkflowInput> & {
    libraryLocationReferenceHash?: string | null;
  }
): Promise<LocationSheetInputHash> {
  return computeLocationSheetInputHash({
    ...locationSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
  });
}

/** Dual-hash verify against a stored location-sheet digest. */
export async function locationSheetHashMatchesStored(
  stored: string | null,
  input: SheetPayload<LocationSheetWorkflowInput> & {
    libraryLocationReferenceHash?: string | null;
  }
): Promise<boolean> {
  return locationSheetInputHashMatches(stored, {
    ...locationSheetHashInput(input),
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
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
  input: SheetPayload<LibraryTalentSheetWorkflowInput>
): Promise<TalentSheetInputHash> {
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

/**
 * Library location references are content-addressed the same way the talent
 * twin is: the name/description the sheet was generated for, the inlined
 * reference URLs, and the model.
 */
export async function computeLibraryLocationSheetHashFromDto(
  input: SheetPayload<LibraryLocationSheetWorkflowInput>
): Promise<LibraryLocationReferenceInputHash> {
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
 * A character's sheet is the one of the look the scene picks for it (#2015):
 * the returned characters are dressed, so `lookId` names that look. Editing a
 * look moves only the shots of the scenes that pick it, and switching a
 * scene's look moves only that scene's shots.
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
      characterLooks?: Record<string, string>;
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
    characterLooks: scene?.continuity?.characterLooks,
    visualPrompt,
  });
  const matchedLocations = matchLocationsToScene(
    locations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? '',
    scene?.originalScript?.extract,
    visualPrompt
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
  scene: StillHashInput,
  imageModel: string,
  aspectRatio: string
): Promise<ShotImageInputHash> {
  const hashInput: ShotImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: scene.visualPrompt,
    imageModel,
    aspectRatio,
    size: null,
    seed: null,
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
    scenes: [...input.sceneSnapshots].sort(
      (a, b) =>
        a.sceneId.localeCompare(b.sceneId) ||
        (a.shotId ?? '').localeCompare(b.shotId ?? '')
    ),
  });
}
