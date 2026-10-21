/**
 * Build a LocationSheetWorkflow payload from the live location row.
 */

import type {
  LocationReferencePhoto,
  LocationSheetVariant,
  LocationWithReference,
  SequenceLocationWithReference,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { renderingForLocation } from '@/cast/rendering';
import { resolveSheetImageModel } from '@/cast/sheet-image-model';
import type { LocationSheetWorkflowInput } from '@/platform/server/workflow/types';
import { computeLocationSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import type { SheetPayload } from '@/cast/server/workflows/sheet-snapshots';

/** Narrow DB text column to the typed union, defaulting to 'interior'. */
function parseLocationType(
  value: string | null
): 'interior' | 'exterior' | 'both' {
  if (value === 'interior' || value === 'exterior' || value === 'both') {
    return value;
  }
  return 'interior';
}

/**
 * Convert flat DB columns to the nested LocationBibleEntry shape. A location
 * read from no sequence has no script id or first mention: it goes by its own
 * id, which is what its sheet run and its hash need of it.
 */
export function toLocationMetadata(
  location: LocationWithReference | SequenceLocationWithReference
): LocationSheetWorkflowInput['locationMetadata'] {
  const link = 'linkId' in location ? location : null;
  return {
    locationId: link?.locationId ?? location.id,
    name: location.name,
    type: parseLocationType(location.type),
    description: location.description ?? '',
    architecturalStyle: location.architecturalStyle ?? '',
    keyFeatures: location.keyFeatures ?? '',
    ambiance: location.ambiance ?? '',
    rendering: renderingForLocation(location.rendering),
    consistencyTag: location.consistencyTag ?? '',
    firstMention: {
      sceneId: link?.firstMentionSceneId ?? '',
      text: link?.firstMentionText ?? '',
      lineNumber: link?.firstMentionLine ?? 0,
    },
  };
}

/** The rows a location sheet payload reads besides the location. */
export type LocationSheetPayloadRows = {
  liveVersion: Pick<LocationSheetVariant, 'model'> | null;
  photos: readonly Pick<LocationReferencePhoto, 'url'>[];
};

export async function loadLocationSheetPayloadRows(
  scopedDb: Pick<ScopedDb, 'locationSheetVariants' | 'locations'>,
  location: Pick<LocationWithReference, 'id' | 'selectedReferenceVersionId'>
): Promise<LocationSheetPayloadRows> {
  const [liveVersion, photos] = await Promise.all([
    location.selectedReferenceVersionId
      ? scopedDb.locationSheetVariants.getById(
          location.selectedReferenceVersionId
        )
      : null,
    scopedDb.locations.listPhotos(location.id),
  ]);
  return { liveVersion: liveVersion ?? null, photos };
}

/**
 * The payload a regenerate of this location's sheet would send, hash
 * included: what a trigger sends and what staleness compares a stored digest
 * with. `sequence` is null from the Locations page (#1695): the image model
 * is then the live version's, else the default. The sheet reads no style.
 */
export async function buildRegenerateLocationSheetPayload(params: {
  scopedDb: ScopedDb;
  userId: string;
  teamId: string;
  sequence: { id: string; imageModel: string | null } | null;
  location: LocationWithReference | SequenceLocationWithReference;
  /** Generate-time pick; omit to reuse the live version's model or the sequence default. */
  imageModel?: string | null;
  /** Already read for this location; omitted, they are read here (#2082). */
  preloaded?: LocationSheetPayloadRows;
}): Promise<Omit<LocationSheetWorkflowInput, 'referenceVersionId'>> {
  const { scopedDb, userId, teamId, sequence, location } = params;

  const { liveVersion, photos } =
    params.preloaded ??
    (await loadLocationSheetPayloadRows(scopedDb, location));

  const partialFields: SheetPayload<LocationSheetWorkflowInput> = {
    userId,
    teamId,
    sequenceId: sequence?.id ?? null,
    locationDbId: location.id,
    locationName: location.name,
    locationMetadata: toLocationMetadata(location),
    bibleVersionId: location.selectedBibleVersionId,
    imageModel: resolveSheetImageModel({
      explicit: params.imageModel,
      liveVersionModel: liveVersion?.model,
      sequenceImageModel: sequence?.imageModel ?? null,
    }),
    referencePhotoUrls: photos.map((photo) => photo.url).sort(),
  };
  return {
    ...partialFields,
    snapshotInputHash: await computeLocationSheetHashFromDto(partialFields),
  };
}
