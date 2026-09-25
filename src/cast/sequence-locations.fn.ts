import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { isValidTextToImageModel, safeTextToImageModel } from '@/models/models';
import type { LocationBibleUpdate } from '@/cast/server/db/sequence-locations';
import type { SheetStaleness } from '@/cast/server/sheets/sheet-staleness';
import {
  bibleField,
  identityToken,
  nextIdentityToken,
  slugifyTag,
} from './bible-field';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import { getGenerationChannel } from '@/platform/realtime';
import {
  buildRegenerateLocationSheetPayload,
  toLocationMetadata,
} from '@/cast/server/sheets/location-sheet-trigger';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type {
  LocationSheetWorkflowInput,
  RecastLocationWorkflowInput,
} from '@/platform/server/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/cast/server/workflows/recast-snapshot';
import { locationSheetHashMatchesStored } from '@/cast/server/workflows/sheet-snapshots';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { NotFoundError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';

const logger = getLogger(['openstory', 'serverFn', 'sequence-locations']);

export const getSequenceLocationsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.list(context.sequence.id);
  });

// ============================================================================
// Manual location CRUD (#1108 Phase 2)
// ============================================================================

const locationBibleFieldsSchema = z.object({
  type: z.enum(['interior', 'exterior', 'both']).optional(),
  timeOfDay: bibleField.optional(),
  description: bibleField.optional(),
  architecturalStyle: bibleField.optional(),
  keyFeatures: bibleField.optional(),
  colorPalette: bibleField.optional(),
  lightingSetup: bibleField.optional(),
  ambiance: bibleField.optional(),
  consistencyTag: bibleField.optional(),
});

/**
 * Create a location by hand (no storyboard run) — starts reference-less
 * (`referenceStatus: 'pending'`); the reference image comes later via the
 * existing recast / sheet workflows. `locationId` is a shortened name
 * (`loc_office`) like script-extracted `loc_001`, uniqued against existing
 * rows on the `(sequenceId, locationId)` index.
 */
export const createSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      locationBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        name: z.string().trim().min(1).max(255),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, name, ...bible } = data;
    const base = identityToken('loc', name);
    const taken = new Set<string>();
    let locationId = base;
    while (
      await context.scopedDb.sequenceLocations.getByLocationId(
        sequenceId,
        locationId
      )
    ) {
      taken.add(locationId);
      locationId = nextIdentityToken(base, taken);
    }
    const location = await context.scopedDb.sequenceLocations.create(
      {
        sequenceId,
        locationId,
        name,
        ...bible,
        consistencyTag:
          bible.consistencyTag ?? `${locationId}: ${slugifyTag(name)}`,
        referenceStatus: 'pending',
      },
      { source: 'edit', createdBy: context.user.id }
    );
    await context.scopedDb.sequenceEvents.record({
      sequenceId,
      actorId: context.user.id,
      kind: 'location.created',
      targetType: 'location',
      targetId: location.id,
      summary: `Added location ${name}`,
      data: { name, locationId },
    });
    return location;
  });

/**
 * Edit a location's bible fields. Only provided fields change; the location
 * sheet and the prompts that project them re-stale purely by hash derivation.
 * Library binding stays on `recastLocationFn`.
 */
export const updateSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      locationBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        locationDbId: ulidSchema,
        name: z.string().trim().min(1).max(255).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, locationDbId, ...fields } = data;
    const existing =
      await context.scopedDb.sequenceLocations.getById(locationDbId);
    if (!existing || existing.sequenceId !== sequenceId) {
      throw new NotFoundError('Location not found');
    }
    const update: LocationBibleUpdate = fields;
    return await context.scopedDb.sequenceLocations.updateBible(
      locationDbId,
      update,
      { actorId: context.user.id }
    );
  });

const locationIdInput = z.object({
  sequenceId: ulidSchema,
  locationDbId: ulidSchema,
});

/**
 * Soft-remove a location (undoable; toast Undo calls the restore fn). Scene
 * continuity tags are NOT stripped — undo is lossless.
 */
export const softDeleteSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationIdInput))
  .handler(async ({ context, data }) => {
    const existing = await context.scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!existing || existing.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Location not found');
    }
    const deletedAt = await context.scopedDb.sequenceLocations.softDelete(
      data.locationDbId,
      { actorId: context.user.id }
    );
    return { locationDbId: data.locationDbId, deletedAt };
  });

/** Undo a location soft-delete. */
export const restoreSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationIdInput))
  .handler(async ({ context, data }) => {
    const existing = await context.scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!existing || existing.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Location not found');
    }
    return await context.scopedDb.sequenceLocations.restore(data.locationDbId, {
      actorId: context.user.id,
    });
  });

export const getTeamLocationsLibraryFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.getTeamLibrary(context.teamId, {
      completedOnly: false,
    });
  });

const getShotIdsForLocationInputSchema = z.object({
  locationId: z.string().min(1),
});

export const getShotIdsForLocationFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(getShotIdsForLocationInputSchema))
  .handler(async ({ context, data }) => {
    const shotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        context.sequence.id,
        data.locationId
      );
    return { shotIds, count: shotIds.length };
  });

const recastLocationInputSchema = z.object({
  locationId: z.string().min(1),
  libraryLocationId: z.string().min(1),
  referenceImageUrl: mediaUrlSchema,
  description: z.string().optional(),
});

export const regenerateLocationSheetFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      locationIdInput.extend({
        imageModel: z
          .string()
          .refine(isValidTextToImageModel, {
            message: 'Invalid image model',
          })
          .optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!location || location.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Location not found');
    }

    const payload = await buildRegenerateLocationSheetPayload({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      teamId: context.teamId,
      sequence: context.sequence,
      location,
      imageModel: data.imageModel,
    });

    // The claim (#1113): last kickoff wins, and any edit to the location's
    // inputs before this run lands revokes it.
    const referenceVersionId =
      await context.scopedDb.sequenceLocations.claimReference(location.id, {
        markGenerating: true,
      });
    try {
      await getGenerationChannel(location.sequenceId).emit(
        'generation.location-sheet:progress',
        { locationId: location.id, status: 'generating' }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    let workflowRunId: string;
    try {
      const claimed: LocationSheetWorkflowInput = {
        ...payload,
        referenceVersionId,
      };
      workflowRunId = await triggerWorkflow('/location-sheet', claimed, {
        // Explicit regen must not reuse the bible-child id
        // `location-sheet:${id}` — that instance is already complete, and CF
        // would no-op a second Generate. Same pattern as generateTalentSheetFn.
      });
    } catch (error) {
      await context.scopedDb.sequenceLocations.failReferenceClaim(
        location.id,
        referenceVersionId,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    return { locationDbId: location.id, workflowRunId };
  });

export const getLocationSheetStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationIdInput))
  .handler(async ({ context, data }): Promise<SheetStaleness> => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!location || location.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Location not found');
    }
    if (location.referenceStatus === 'generating') return 'generating';
    if (location.referenceInputHash == null) return 'untracked';

    const payload = await buildRegenerateLocationSheetPayload({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      teamId: context.teamId,
      sequence: context.sequence,
      location,
    });
    if (!payload.snapshotInputHash) return 'untracked';
    return (await locationSheetHashMatchesStored(
      location.referenceInputHash,
      payload
    ))
      ? 'fresh'
      : 'stale';
  });

/**
 * Recast a location with a library location reference.
 * Triggers location reference regeneration and shot regeneration.
 */
export const recastLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(recastLocationInputSchema))
  .handler(async ({ context, data }) => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationId
    );
    if (!location) {
      throw new NotFoundError('Location not found');
    }

    // Fetch the sequence's style for location sheet generation
    const sequence = await context.scopedDb.sequences.getForUser({
      sequenceId: location.sequenceId,
    });
    const style =
      sequence.styleConfig == null && sequence.styleId
        ? await context.scopedDb.styles.getById(sequence.styleId)
        : null;
    const styleConfig =
      sequence.styleConfig != null || style
        ? resolveSequenceStyleConfig({
            snapshot: sequence.styleConfig,
            live: style?.config,
          })
        : undefined;

    // Bind the sequence location to the library location it was recast from.
    // Without this the downstream divergence check resolves the OLD (usually
    // null) link and compares against a hash from the new one.
    const libraryLocation = await context.scopedDb.locations.getById(
      data.libraryLocationId
    );
    if (!libraryLocation) {
      throw new Error('Library location not found');
    }
    await context.scopedDb.sequenceLocations.update(data.locationId, {
      libraryLocationId: data.libraryLocationId,
    });
    // Re-read rather than use the write's row: the recast snapshot needs the
    // live reference, which resolves from the version pointer (#1419).
    const updatedLocation = await context.scopedDb.sequenceLocations.getById(
      data.locationId
    );
    if (!updatedLocation) {
      throw new NotFoundError('Location not found');
    }

    // Claimed after the relink above, which revokes older claims (#1113).
    const referenceVersionId =
      await context.scopedDb.sequenceLocations.claimReference(data.locationId, {
        markGenerating: true,
      });

    await getGenerationChannel(location.sequenceId).emit(
      'generation.location-sheet:progress',
      { locationId: data.locationId, status: 'generating' }
    );

    const affectedShotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        location.sequenceId,
        data.locationId
      );

    // Freeze every regenerate-shots input here, at the trigger. The workflow
    // used to rebuild this after its sheet child finished — eight live reads
    // against state the user never authorised.
    const imageModel = safeTextToImageModel(sequence.imageModel);
    const { shotSnapshots, snapshotInputHash } =
      await buildRecastRegenerateSnapshots({
        scopedDb: context.scopedDb,
        sequenceId: location.sequenceId,
        shotIds: affectedShotIds,
        imageModel,
        aspectRatio: sequence.aspectRatio,
        subject: { kind: 'location', location: updatedLocation },
      });

    const workflowRunId = await triggerWorkflow('/recast-location', {
      locationDbId: data.locationId,
      locationName: location.name,
      locationMetadata: toLocationMetadata(location),
      sequenceId: location.sequenceId,
      teamId: context.teamId,
      userId: context.user.id,
      referenceImageUrl: data.referenceImageUrl,
      libraryLocationDescription: data.description,
      libraryLocationId: data.libraryLocationId,
      libraryLocationReferenceHash: libraryLocation.referenceInputHash,
      referenceVersionId,
      bibleVersionId: updatedLocation.selectedBibleVersionId,
      imageModel,
      styleConfig,
      aspectRatio: sequence.aspectRatio,
      resolution: sequence.resolution,
      shotSnapshots,
      snapshotInputHash,
    } satisfies RecastLocationWorkflowInput);

    return {
      locationId: data.locationId,
      referenceWorkflowRunId: workflowRunId,
      // The shots actually queued — a shot with no selected image prompt is
      // dropped by the snapshot builder rather than failing the recast.
      affectedShotIds: shotSnapshots.map((s) => s.shotId),
    };
  });
