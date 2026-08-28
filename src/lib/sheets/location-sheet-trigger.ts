/**
 * Build a LocationSheetWorkflow payload from the live sequence-location row.
 */

import type { SequenceLocation } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { resolveSheetImageModel } from '@/lib/sheets/sheet-image-model';
import { resolveSequenceStyleConfig } from '@/lib/style/style-config';
import type { LocationSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLocationSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';

/** Narrow DB text column to the typed union, defaulting to 'interior'. */
function parseLocationType(
  value: string | null
): 'interior' | 'exterior' | 'both' {
  if (value === 'interior' || value === 'exterior' || value === 'both') {
    return value;
  }
  return 'interior';
}

/** Convert flat DB columns to the nested LocationBibleEntry shape. */
export function toLocationMetadata(
  location: SequenceLocation
): LocationSheetWorkflowInput['locationMetadata'] {
  return {
    locationId: location.locationId,
    name: location.name,
    type: parseLocationType(location.type),
    timeOfDay: location.timeOfDay ?? '',
    description: location.description ?? '',
    architecturalStyle: location.architecturalStyle ?? '',
    keyFeatures: location.keyFeatures ?? '',
    colorPalette: location.colorPalette ?? '',
    lightingSetup: location.lightingSetup ?? '',
    ambiance: location.ambiance ?? '',
    consistencyTag: location.consistencyTag ?? '',
    firstMention: {
      sceneId: location.firstMentionSceneId ?? '',
      text: location.firstMentionText ?? '',
      lineNumber: location.firstMentionLine ?? 0,
    },
  };
}

export async function buildRegenerateLocationSheetPayload(params: {
  scopedDb: ScopedDb;
  userId: string;
  teamId: string;
  sequence: {
    id: string;
    styleId: string | null;
    styleConfig: Parameters<typeof resolveSequenceStyleConfig>[0]['snapshot'];
    imageModel: string | null;
  };
  location: SequenceLocation;
  /** Generate-time pick; omit to reuse the live version's model or the sequence default. */
  imageModel?: string | null;
}): Promise<LocationSheetWorkflowInput> {
  const { scopedDb, userId, teamId, sequence, location } = params;
  const style =
    sequence.styleConfig == null && sequence.styleId
      ? await scopedDb.styles.getById(sequence.styleId)
      : null;
  const styleConfig =
    sequence.styleConfig != null || style
      ? resolveSequenceStyleConfig({
          snapshot: sequence.styleConfig,
          live: style?.config,
        })
      : undefined;

  let referenceImageUrl: string | undefined;
  let libraryLocationDescription: string | undefined;
  let libraryLocationReferenceHash: string | null = null;
  if (location.libraryLocationId) {
    const library = await scopedDb.locations.getById(
      location.libraryLocationId
    );
    referenceImageUrl = library?.referenceImageUrl ?? undefined;
    libraryLocationDescription = library?.description ?? undefined;
    libraryLocationReferenceHash = library?.referenceInputHash ?? null;
  }

  const liveVersion = location.selectedReferenceVersionId
    ? await scopedDb.locationSheetVariants.getById(
        location.selectedReferenceVersionId
      )
    : null;

  const partial: LocationSheetWorkflowInput = {
    userId,
    teamId,
    sequenceId: sequence.id,
    locationDbId: location.id,
    locationName: location.name,
    locationMetadata: toLocationMetadata(location),
    imageModel: resolveSheetImageModel({
      explicit: params.imageModel,
      liveVersionModel: liveVersion?.model,
      sequenceImageModel: sequence.imageModel,
    }),
    referenceImageUrl,
    libraryLocationDescription,
    styleConfig,
    libraryLocationReferenceHash,
  };
  partial.snapshotInputHash = await computeLocationSheetHashFromDto(partial);
  return partial;
}
