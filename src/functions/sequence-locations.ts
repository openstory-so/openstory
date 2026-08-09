import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { safeTextToImageModel } from '@/lib/ai/models';
import { generateId } from '@/lib/db/id';
import { type SequenceLocation, StyleConfigSchema } from '@/lib/db/schema';
import type { LocationBibleUpdate } from '@/lib/db/scoped/sequence-locations';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { RecastLocationWorkflowInput } from '@/lib/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/lib/workflows/recast-snapshot';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

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
function toLocationMetadata(
  location: SequenceLocation
): RecastLocationWorkflowInput['locationMetadata'] {
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

export const getSequenceLocationsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.list(context.sequence.id);
  });

// ============================================================================
// Manual location CRUD (#1108 Phase 2)
// ============================================================================

/** `''` / whitespace clears a nullable bible field; otherwise trimmed text. */
const bibleField = z
  .string()
  .max(2000)
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

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

/** Lowercase, underscore-joined identity token derived from a display name. */
function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Create a location by hand (no storyboard run) — starts reference-less
 * (`referenceStatus: 'pending'`); the reference image comes later via the
 * existing recast / sheet workflows. `locationId` is minted fresh so the
 * manual row can never collide with a script-extracted one on the
 * `(sequenceId, locationId)` unique index.
 */
export const createSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      locationBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        name: z.string().trim().min(1).max(255),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, name, ...bible } = data;
    const locationId = `loc_${generateId().toLowerCase()}`;
    const location = await context.scopedDb.sequenceLocations.create({
      sequenceId,
      locationId,
      name,
      ...bible,
      consistencyTag:
        bible.consistencyTag ?? `${locationId}: ${slugifyTag(name)}`,
      referenceStatus: 'pending',
    });
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
  .inputValidator(
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
  .inputValidator(zodValidator(locationIdInput))
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
  .inputValidator(zodValidator(locationIdInput))
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
  .inputValidator(zodValidator(getShotIdsForLocationInputSchema))
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

/**
 * Recast a location with a library location reference.
 * Triggers location reference regeneration and shot regeneration.
 */
export const recastLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(recastLocationInputSchema))
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
    const style = sequence.styleId
      ? await context.scopedDb.styles.getById(sequence.styleId)
      : null;
    const styleConfig = style
      ? StyleConfigSchema.parse(style.config)
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
    const updatedLocation = await context.scopedDb.sequenceLocations.update(
      data.locationId,
      { libraryLocationId: data.libraryLocationId }
    );

    await context.scopedDb.sequenceLocations.updateReferenceStatus(
      data.locationId,
      'generating'
    );

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

    const workflowRunId = await triggerWorkflow(
      '/recast-location',
      {
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
        imageModel,
        styleConfig,
        aspectRatio: sequence.aspectRatio,
        shotSnapshots,
        snapshotInputHash,
      } satisfies RecastLocationWorkflowInput,
      { label: buildWorkflowLabel(location.sequenceId) }
    );

    return {
      locationId: data.locationId,
      referenceWorkflowRunId: workflowRunId,
      // The shots actually queued — a shot with no selected image prompt is
      // dropped by the snapshot builder rather than failing the recast.
      affectedShotIds: shotSnapshots.map((s) => s.shotId),
    };
  });
