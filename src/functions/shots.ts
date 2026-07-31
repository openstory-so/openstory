import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  isValidTextToImageModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import { estimateImageCost } from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import { getWorkflowRunOutcome } from '@/lib/workflow/run-outcome';
import type { ShotVariant, NewShot } from '@/lib/db/schema';
import {
  computeShotStaleness,
  UNTRACKED_STALENESS,
  type ShotStalenessRefs,
  type ShotStalenessResult,
} from '@/lib/shots/shot-staleness';
import {
  projectShotWithImage,
  projectShotMissingFrame,
  type ShotGridSheet,
} from '@/lib/shots/shot-with-image';
import { getGenerationChannel } from '@/lib/realtime';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import { motionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { projectVideoVariants } from '@/lib/motion/video-variant-projection';
import {
  bulkShotSchema,
  singleShotSchema,
  updateShotSchema,
} from '@/lib/schemas/shot.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { typedFromEntries } from '@/lib/utils/typed-object';
import {
  enrichShotWithSceneScript,
  loadSelectedScriptsBySequence,
  projectShotForClient,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { UpdateStaleShotsWorkflowInput } from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authWithTeamMiddleware,
  shotAccessMiddleware,
  sequenceAccessMiddleware,
} from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'shots']);

const shotIdInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const getShotsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb, sequence } = context;
    const shotRows = await scopedDb.shots.listBySequence(sequence.id);
    // Guarantee every shot has its anchor frame, then project the image surface
    // (#989) back under the legacy thumbnail*/image* names so the UI is unchanged.
    await scopedDb.shots.ensureAnchorFrames(shotRows);
    const [anchorRows, gridSheets, motionByShot, scriptBySceneId] =
      await Promise.all([
        scopedDb.frames.listAnchorsBySequence(sequence.id),
        scopedDb.frameVariants.listLatestGridSheetsBySequence(sequence.id),
        scopedDb.shotPromptVersions.getSelectedMotionByShots(
          shotRows.map((s) => s.id)
        ),
        loadSelectedScriptsBySequence(scopedDb, sequence.id),
      ]);
    const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
    return shotRows.map((rawShot) => {
      const shot = enrichShotWithSceneScript(rawShot, scriptBySceneId);
      const frame = anchorsByShot.get(shot.id);
      const selectedMotion = motionByShot.get(shot.id);
      const motionPromptData = selectedMotion
        ? motionPromptFromVersion(selectedMotion)
        : null;
      // `ensureAnchorFrames` above guarantees an anchor for every shot, so this
      // is normally unreachable. If it ever isn't, preserve the shot with a null
      // image surface (matching the sibling read paths in sequences/admin)
      // rather than silently dropping it from the scenes list.
      if (!frame) {
        logger.error(
          `getShotsFn: shot ${shot.id} has no anchor frame after ensureAnchorFrames`
        );
        return projectShotMissingFrame(shot);
      }
      // Grid sheets are keyed by frame id (#989), resolved from the anchor.
      const sheet = gridSheets.get(frame.id);
      const gridSheet: ShotGridSheet | null = sheet
        ? { url: sheet.url, status: sheet.status }
        : null;
      return projectShotWithImage(shot, frame, gridSheet, motionPromptData);
    });
  });

/**
 * Batched variant of `getShotsFn` for list-style pages that need shots for
 * many sequences at once. The sequences list page used to fire one
 * `getShotsFn` per row; with 50+ sequences this saturated iOS Chrome's
 * connection pool, queued every subsequent navigation request, and killed
 * the WebProcess (root cause of the "Can't open this page" report).
 *
 * Team scoping is enforced by the join inside `sequences.listShotsByIds`,
 * so caller-supplied ids from another team return nothing rather than leak.
 * `listShotsByIds` chunks the ids to respect D1's bound-parameter limit, so
 * the cap here is only an abuse guard on request size — a team's full sequence
 * list (which the sequences/eval pages send) used to overflow the old 500 cap
 * once it grew past 500 sequences (#957).
 */
export const getShotsForSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceIds: z.array(ulidSchema).max(5000),
      })
    )
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.sequences.listShotsByIds(data.sequenceIds);
  });

export const getShotFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .handler(async ({ context }) => {
    const [sheet, selectedMotion] = await Promise.all([
      context.scopedDb.frameVariants.getLatestGridSheet(context.frame.id),
      context.scopedDb.shotPromptVersions.getSelectedMotion(context.shot.id),
    ]);
    const shot = projectShotForClient(context.shot, context.script);
    return projectShotWithImage(
      shot,
      context.frame,
      sheet ? { url: sheet.url, status: sheet.status } : null,
      selectedMotion ? motionPromptFromVersion(selectedMotion) : null
    );
  });

export const getSequenceImageModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const models = await context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id
    );
    // Preview thumbnails are generated with a hidden internal model
    // (PREVIEW_IMAGE_MODEL = flux_2_turbo) and stored as image variants. Hide
    // such hidden models from the user-facing sequence image-model list — they
    // aren't a real choice and only confuse the header dropdown.
    return models.filter(
      (model) =>
        !(isValidTextToImageModel(model) && 'hidden' in IMAGE_MODELS[model])
    );
  });

export const getSequenceVideoModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Video models now come from `video_variants` (#990).
    return context.scopedDb.videoVariants.listModelsForSequence(
      context.sequence.id
    );
  });

export const getDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.shotVariants.listDivergentBySequence(
      context.sequence.id
    );
  });

type PromoteProgressEvent = 'video:progress' | 'audio:progress';
type PromoteProgressUrlField = 'videoUrl' | 'audioUrl';

/**
 * Build the per-variantType `shots` update payload and matching realtime
 * progress event metadata for a promote-variant operation. Exported (and
 * pure) for unit testing — the server-fn handler wraps this in auth +
 * persistence.
 *
 * Image promotion is retired (#989): image variants live in `frame_variants`
 * and selection is a pointer repoint via `setImageFromVariantFn` /
 * `frameVariants.select`, not a divergent-alternate promote. This only handles
 * the video/audio variants that still live on `shot_variants`.
 */
export function buildPromoteUpdate(variant: ShotVariant): {
  update: Partial<NewShot>;
  progressEvent: PromoteProgressEvent;
  progressUrlField: PromoteProgressUrlField;
} {
  const update: Partial<NewShot> = {};
  let progressEvent: PromoteProgressEvent;
  let progressUrlField: PromoteProgressUrlField;

  switch (variant.variantType) {
    case 'image':
      throw new Error(
        'Image variants are not promoted — select via frameVariants.select (#989)'
      );
    case 'video':
      update.videoUrl = variant.url;
      update.videoPath = variant.storagePath;
      update.videoStatus = 'completed';
      update.videoError = null;
      update.videoInputHash = variant.inputHash;
      progressEvent = 'video:progress';
      progressUrlField = 'videoUrl';
      break;
    case 'audio':
      update.audioUrl = variant.url;
      update.audioPath = variant.storagePath;
      update.audioStatus = 'completed';
      update.audioError = null;
      update.audioInputHash = variant.inputHash;
      progressEvent = 'audio:progress';
      progressUrlField = 'audioUrl';
      break;
  }

  return { update, progressEvent, progressUrlField };
}

/**
 * Promote a divergent alternate to be the live primary for its variant type.
 * Copies the variant's url/path into the matching shots column, updates the
 * matching `*_input_hash` so the live row reflects the alternate's inputs,
 * soft-deletes the variant, and emits a synthetic `*:progress` event so any
 * listeners refresh.
 */
export const promoteVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { shot, scopedDb } = context;
    const variant = await scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== shot.id) {
      throw new Error('Variant not found for this shot');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const { update, progressEvent, progressUrlField } =
      buildPromoteUpdate(variant);

    // Atomic: a partial failure can't leave the live primary updated with the
    // variant still appearing in the divergent list (or vice versa).
    const { shot: updatedShot } = await scopedDb.shotVariants.promoteAtomically(
      shot.id,
      update,
      variant.id
    );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    const channel = getGenerationChannel(data.sequenceId);
    try {
      const url = updatedShot[progressUrlField] ?? variant.url;
      await channel.emit(
        `generation.${progressEvent}`,
        progressEvent === 'audio:progress'
          ? {
              shotId: shot.id,
              status: 'completed',
              audioUrl: url,
            }
          : {
              shotId: shot.id,
              status: 'completed',
              videoUrl: url,
              model: variant.model,
            }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { shot: updatedShot, variantId: variant.id };
  });

export const discardVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== context.shot.id) {
      throw new Error('Variant not found for this shot');
    }
    const discardedAt = await context.scopedDb.shotVariants.discard(variant.id);
    return { variantId: variant.id, discardedAt };
  });

export const undiscardVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== context.shot.id) {
      throw new Error('Variant not found for this shot');
    }
    await context.scopedDb.shotVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });

export const getSequenceImageVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Image variants moved to `frame_variants` (#989). Each row carries its
    // owning `shotId` (frame ids ≠ shot ids) so the client coverage logic keyed
    // by shot keeps working.
    return context.scopedDb.frameVariants.listModelVersionsBySequence(
      context.sequence.id
    );
  });

export const getSequenceVideoVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Video lives in `video_variants` now (#990). Project it into the legacy
    // per-(shot, model) `ShotVariant` shape so the scenes-view switcher /
    // coverage keep reading the same fields (latest version per shot+model;
    // `divergedAt` always null — selection is a pointer).
    const versions = await context.scopedDb.videoVariants.listBySequence(
      context.sequence.id
    );
    return projectVideoVariants(versions);
  });

/**
 * The model recorded on each shot's SELECTED image / video version (#1066).
 * Model identity lives on the version row that produced the asset, so the
 * editor resolves the model it shows (and generates with) from this — via the
 * same `resolveImageModel`/`resolveVideoModel` the server write paths use.
 * Shots with no selection are simply absent, and the caller falls back to the
 * sequence default.
 */
export const getSequenceSelectedModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const [image, video, failedImage, failedVideo] = await Promise.all([
      context.scopedDb.frameVariants.listSelectedModelsBySequence(
        context.sequence.id
      ),
      context.scopedDb.videoVariants.listSelectedModelsBySequence(
        context.sequence.id
      ),
      context.scopedDb.frameVariants.listLastFailedModelsBySequence(
        context.sequence.id
      ),
      context.scopedDb.videoVariants.listLastFailedModelsBySequence(
        context.sequence.id
      ),
    ]);
    // Plain records, not Maps — this crosses the server-fn JSON boundary.
    return {
      imageModelByShot: typedFromEntries([...image]),
      videoModelByShot: typedFromEntries([...video]),
      // The failed-attempt tier, so the editor shows the same model a retry
      // would run (#1066) rather than the older selected one.
      failedImageModelByShot: typedFromEntries([...failedImage]),
      failedVideoModelByShot: typedFromEntries([...failedVideo]),
    };
  });

export const createShotFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(singleShotSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.shots.create(data);
  });

export const createShotsBulkFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shots: bulkShotSchema.shape.shots,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const shotInserts: NewShot[] = data.shots.map((shot) => ({
      sequenceId: data.sequenceId,
      ...shot,
    }));
    return context.scopedDb.shots.bulkUpsert(shotInserts);
  });

export const updateShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      updateShotSchema.extend({ sequenceId: ulidSchema, shotId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, shotId, ...updateData } = data;

    // Scene-script edits route through `updateSceneScriptFn` (#1030). Reject
    // legacy metadata.originalScript writes so the shot copy stays write-only.
    if (updateData.metadata?.originalScript?.extract !== undefined) {
      throw new Error(
        'Scene script edits must use updateSceneScriptFn (#1030)'
      );
    }

    // When a user edits a prompt, auto-link any element/cast/location tags
    // they mentioned by additively merging them into shot.metadata.continuity
    // so the next generation pulls those references in (#683). Skip when the
    // prompt value hasn't actually changed, so plain saves stay a single
    // UPDATE with no extra reads.
    const imagePromptChanged =
      updateData.imagePrompt !== undefined &&
      updateData.imagePrompt !== context.frame.imagePrompt;
    const motionPromptChanged =
      updateData.motionPrompt !== undefined &&
      updateData.motionPrompt !== context.shot.motionPrompt;
    const shotMetadata = context.shot.metadata;
    if (
      (imagePromptChanged || motionPromptChanged) &&
      shotMetadata?.continuity
    ) {
      const promptText = [
        imagePromptChanged ? updateData.imagePrompt : null,
        motionPromptChanged ? updateData.motionPrompt : null,
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');

      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId,
        existing: shotMetadata.continuity,
        promptText,
      });

      if (rescan.changed) {
        updateData.metadata = {
          ...shotMetadata,
          continuity: rescan.continuity,
        };
      }
    }

    // The image prompt lives on the anchor frame (#989), not a `shots` column.
    // Persist a changed prompt as a user-edit `frame_prompt_versions` row (which
    // mirrors it onto `frame.imagePrompt` + repoints the pointer), then drop it
    // from the shots UPDATE.
    const { imagePrompt: editedImagePrompt, ...shotUpdate } = updateData;
    if (
      imagePromptChanged &&
      typeof editedImagePrompt === 'string' &&
      editedImagePrompt.length > 0
    ) {
      await context.scopedDb.framePromptVersions.write({
        frameId: context.frame.id,
        text: editedImagePrompt,
        source: 'user-edit',
        inputHash: null,
        analysisModel: null,
        createdBy: context.user.id,
      });
    }

    return context.scopedDb.shots.update(shotId, shotUpdate);
  });

const updateShotDurationSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  durationSeconds: z.number().positive(),
});

/**
 * Set a shot's duration — a **video** parameter, not a prompt driver.
 *
 * `sceneInputContext` (input-hash.ts) deliberately allowlists `durationSeconds`
 * OUT of the prompt hashes, so changing it re-stales the render
 * (`computeShotVideoInputHash`) and nothing else. That's why this is its own
 * endpoint rather than a field on `updateSceneScriptFn`: a duration edit must
 * not append a `scene_script_versions` row or touch prompt staleness.
 *
 * A scene has no duration of its own — its duration is the sum of its shots'
 * (`tileSceneIntoSegments` reads exactly these values against the model cap).
 * The `metadata.metadata.durationSeconds` write is the legacy mirror kept in
 * step so the `resolveShotDuration` fallback can't read a stale value.
 */
export const updateShotDurationFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(updateShotDurationSchema))
  .handler(async ({ data, context }) => {
    const { shot, scene, script, scopedDb } = context;

    const patch: Parameters<typeof scopedDb.shots.update>[1] = {
      durationMs: Math.round(data.durationSeconds * 1000),
    };
    if (scene) {
      patch.metadata = {
        ...scene,
        metadata: {
          ...(scene.metadata ?? {
            title: '',
            location: '',
            timeOfDay: '',
            storyBeat: '',
          }),
          durationSeconds: data.durationSeconds,
        },
      };
    }

    const updated = (await scopedDb.shots.update(shot.id, patch)) ?? shot;
    return projectShotForClient(updated, script);
  });

export const deleteShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.shots.delete(data.shotId);
    return { success: true, sequenceId: data.sequenceId };
  });

export const deleteShotsBySequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    await context.scopedDb.shots.deleteBySequence(context.sequence.id);
    return { success: true };
  });

export const reorderShotsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotOrders: z
          .array(z.object({ id: ulidSchema, orderIndex: z.number().int() }))
          .min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const shotOrders = data.shotOrders.map((f) => ({
      id: f.id,
      order_index: f.orderIndex,
    }));
    await context.scopedDb.shots.reorder(data.sequenceId, shotOrders);
    return { success: true };
  });

/**
 * Returns staleness state for a shot's artifacts. Covers the rendered
 * thumbnail plus the visual / motion prompts (stage 4). See
 * `computeShotStaleness` (lib/shots/shot-staleness.ts) for the comparison
 * rules and the three per-artifact states.
 */
export const getShotStalenessFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot, frame, sequence, scopedDb, scene } = context;
    return computeShotStaleness({ scopedDb, sequence, shot, frame, scene });
  });

/**
 * Batched `getShotStalenessFn` (#1077): staleness for every shot in one scene
 * (`sceneId` set) or the whole sequence (`sceneId` omitted), keyed by shot
 * id. Feeds the Scene/Sequence panel's stale-shot summary and the left-rail
 * dots, and lets the client prime the per-shot staleness cache entries in one
 * round trip instead of N.
 */
export const getShotStalenessBatchFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({ sequenceId: ulidSchema, sceneId: ulidSchema.optional() })
    )
  )
  .handler(async ({ data, context }) => {
    const { scopedDb, sequence } = context;
    const allShots = await scopedDb.shots.listBySequence(sequence.id);
    const targetShots = data.sceneId
      ? allShots.filter((shot) => shot.sceneId === data.sceneId)
      : allShots;
    if (targetShots.length === 0) {
      return {};
    }

    await scopedDb.shots.ensureAnchorFrames(targetShots);
    const [anchorRows, scriptBySceneId, characters, locations, elements] =
      await Promise.all([
        scopedDb.frames.listAnchorsBySequence(sequence.id),
        loadSelectedScriptsBySequence(scopedDb, sequence.id),
        scopedDb.characters.listWithSheets(sequence.id),
        scopedDb.sequenceLocations.listWithReferences(sequence.id),
        scopedDb.sequenceElements.list(sequence.id),
      ]);
    const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
    const refs: ShotStalenessRefs = { characters, locations, elements };

    const entries = await Promise.all(
      targetShots.map(async (shot): Promise<[string, ShotStalenessResult]> => {
        const frame = anchorsByShot.get(shot.id);
        if (!frame) {
          // ensureAnchorFrames guarantees an anchor; if it's somehow absent we
          // have no image surface to compare, so report the shot untracked
          // rather than dropping it from the result.
          logger.error(
            `getShotStalenessBatchFn: shot ${shot.id} has no anchor frame`
          );
          return [shot.id, UNTRACKED_STALENESS];
        }
        const { scene } = resolveSceneForShot(shot, scriptBySceneId);
        return [
          shot.id,
          await computeShotStaleness({
            scopedDb,
            sequence,
            shot,
            frame,
            scene,
            refs,
          }),
        ];
      })
    );
    return typedFromEntries(entries);
  });

/**
 * "Update all" (#1077): enqueue the durable `UpdateStaleShotsWorkflow` for a
 * shot / scene / the whole sequence. The workflow recomputes staleness
 * server-side and regenerates only the artifacts that read stale right now —
 * no cascade into artifacts a regeneration outdates, and video never
 * auto-renders — so the payload is just the scope. Returns the run id;
 * progress surfaces through the staleness indicators as artifacts land.
 *
 * Preflights credits before enqueuing. Inside the workflow an out-of-credits
 * failure can only land in the run result, where it reads as "nothing
 * happened" — throwing here is the one point where the client still gets an
 * `InsufficientCreditsError` and can open the billing dialog.
 */
export const updateStaleShotsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        sceneId: ulidSchema.optional(),
        shotId: ulidSchema.optional(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, teamId, user, scopedDb } = context;
    // The plan isn't known yet, so this can't be the exact cost — it's a
    // floor: a run that can't afford even one image should never start.
    await requireCredits(
      scopedDb,
      estimateImageCost(
        safeTextToImageModel(sequence.imageModel, DEFAULT_IMAGE_MODEL),
        sequence.aspectRatio,
        1
      ),
      { errorMessage: 'Insufficient credits to update out-of-date shots' }
    );
    const workflowRunId = await triggerWorkflow<UpdateStaleShotsWorkflowInput>(
      '/update-stale-shots',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneId: data.sceneId,
        shotId: data.shotId,
      },
      { label: buildWorkflowLabel(sequence.id) }
    );
    return { workflowRunId };
  });

/**
 * Shape of `UpdateStaleShotsWorkflow`'s return value. Parsed rather than cast:
 * it crosses the Cloudflare Workflows boundary as `unknown`, and a run from a
 * previously-deployed version of the workflow can legitimately not match.
 */
const updateStaleShotsResultSchema = z.object({
  totalShots: z.number(),
  visualPrompts: z.number(),
  motionPrompts: z.number(),
  images: z.number(),
  failures: z.array(
    z.object({ shotId: z.string(), stage: z.string(), error: z.string() })
  ),
  skipped: z.array(z.object({ shotId: z.string(), reason: z.string() })),
});

/**
 * Terminal outcome of an "Update all" run (#1077).
 *
 * The workflow isolates failures per shot so one bad shot never blocks its
 * peers — which means a run can finish `complete` having regenerated nothing.
 * Without this endpoint that result is written to a log nobody reads and the
 * user just watches a spinner stop. The client polls this and reports what
 * actually happened.
 */
export const getUpdateStaleShotsRunFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({ sequenceId: ulidSchema, workflowRunId: z.string().min(1) })
    )
  )
  .handler(async ({ data }) => {
    const outcome = await getWorkflowRunOutcome(data.workflowRunId);
    if (outcome.state !== 'complete') return outcome;
    const parsed = updateStaleShotsResultSchema.safeParse(outcome.output);
    // A complete run whose output we can't read is not a failure to report as
    // one — fall back to 'unknown' so the UI defers to the staleness map.
    if (!parsed.success) {
      logger.error(
        `getUpdateStaleShotsRunFn: unrecognised output for ${data.workflowRunId}`,
        { issues: parsed.error.issues }
      );
      return { state: 'unknown' as const };
    }
    return { state: 'complete' as const, result: parsed.data };
  });

/**
 * Get a signed download URL for a shot's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getShotDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot } = context;

    if (!shot.videoPath) {
      throw new Error('Shot does not have a video');
    }

    const filename =
      shot.videoPath.split('/').pop() || `scene-${shot.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(
      shot.videoPath,
      filename,
      3600
    );

    return { downloadUrl, filename };
  });
