/**
 * Cloudflare Workflows port of `shotImagesWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/shot-images-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` and the run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computer directly in a `validate-snapshot`
 *     step instead of going through the `context.snapshot.*` extension.
 *   - Per-scene × per-model fan-out uses Pattern 3 — `spawnAndAwaitChild`
 *     against `IMAGE_WORKFLOW`, flattened into (scene, model) jobs and spawned
 *     unbounded (#1143; the per-run ceiling #1126 added measured no benefit).
 *     Per-job settle isolation, so a single failing image (or timeout) doesn't
 *     kill the rest of the batch.
 *   - The variant-image (shot-grid) fire-and-forget kick remains routed
 *     through `triggerWorkflow('/variant-image', …)` for parity with the
 *     QStash original — the engine registry decides whether that hits CF
 *     or QStash per-deploy. */

import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { shotVariantDedupId } from '@/lib/workflow/dedup-ids';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { NonRetryableError } from 'cloudflare:workflows';
import type {
  ShotImagesWorkflowInput,
  ShotImagesWorkflowResult,
  ImageWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToShotImage,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import {
  computeShotImageSceneHash,
  computeShotImagesHashFromDto,
  type ShotImageSceneSnapshot,
} from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'shot-images']);

/** Retry a lone failed primary once so one miss of seven doesn't headline the page (#1286). */
export function loneFailedPrimaryJobIndex(
  jobs: ReadonlyArray<{ model: string }>,
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
  primaryModel: string
): number | null {
  const primaryIndexes: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    if (jobs[i]?.model === primaryModel) primaryIndexes.push(i);
  }
  const failed = primaryIndexes.filter(
    (i) => results[i]?.status === 'rejected'
  );
  return failed.length === 1 ? (failed[0] ?? null) : null;
}

type ImageChildResult = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
  /** The `frame_variants` version this still completed as. Null when none. */
  frameVersionId?: string | null;
};

type ShotImageJobResult = {
  imageUrl: string;
  frameVersionId: string | null;
};

/**
 * Per-scene inputs shared by every (scene, model) job for that scene. Resolved
 * once before the fan-out rather than inside each job, since flattening means
 * a scene is visited once per model.
 */
type SceneImageContext = {
  visualPrompt: string;
  matchedShot:
    | { analysisSceneId: string; shotId: string; frameId: string | null }
    | undefined;
  characterRefs: ReferenceImageDescription[];
  locationRefs: ReferenceImageDescription[];
  elementRefs: ReferenceImageDescription[];
  allReferences: ReferenceImageDescription[];
  sceneSnapshot: ShotImageSceneSnapshot | undefined;
};

export class ShotImagesWorkflow extends OpenStoryWorkflowEntrypoint<ShotImagesWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ShotImagesWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ShotImagesWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;

    // Snapshot validation. The QStash original calls
    // `context.snapshot.validate()` inside a `context.run`; the CF base
    // class has no snapshot extension, so we recompute the DTO hash and
    // compare directly. Top-level throw → `WorkflowValidationError` (the
    // base class re-wraps as CF `NonRetryableError`).
    await step.do('validate-snapshot', async () => {
      if (!input.sceneSnapshots || input.sceneSnapshots.length === 0) {
        // Snapshots are optional — when absent there's nothing to validate.
        return;
      }
      const expected = input.snapshotInputHash ?? '';
      const recomputed = await computeShotImagesHashFromDto({
        ...input,
        sceneSnapshots: input.sceneSnapshots,
      });
      if (recomputed !== expected) {
        // NonRetryableError (not WorkflowValidationError) because the base
        // class's re-wrap only runs at the runImpl catch boundary; a throw
        // inside step.do gets retried by CF's step machinery first.
        throw new NonRetryableError(
          'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently',
          'WorkflowValidationError'
        );
      }
    });

    const {
      scenesWithVisualPrompts,
      charactersWithSheets,
      locationsWithSheets,
      elements: elementsFromInput = [],
      shotMapping,
      imageModel,
      imageModels: imageModelsInput,
      aspectRatio,
      sequenceId,
    } = input;

    const imageModels = resolveImageModels(imageModelsInput, imageModel);

    const label = buildWorkflowLabel(sequenceId);

    // Build per-scene character, location, and element maps for reference
    // image lookup. The payload's elements are the ONLY source: they are what
    // `elementReferenceHashes` / `snapshotInputHash` were computed over at the
    // trigger, so a fresher DB read here would render against elements the
    // stamped hash does not describe.
    const { sceneCharacterMap, sceneLocationMap, sceneElementMap } =
      await step.do('build-reference-maps', async () => {
        const visualPromptBySceneId = Object.fromEntries(
          (input.sceneSnapshots ?? []).map((s) => [s.sceneId, s.visualPrompt])
        );
        return {
          sceneCharacterMap: Object.fromEntries(
            scenesWithVisualPrompts.map((scene) => [
              scene.sceneId,
              matchCharactersToShotImage(charactersWithSheets, {
                characterTags: scene.continuity?.characterTags,
                visualPrompt: visualPromptBySceneId[scene.sceneId] ?? '',
              }),
            ])
          ),
          sceneLocationMap: Object.fromEntries(
            scenesWithVisualPrompts.map((scene) => [
              scene.sceneId,
              matchLocationsToScene(
                locationsWithSheets,
                scene.continuity?.environmentTag || '',
                scene.metadata?.location || ''
              ),
            ])
          ),
          sceneElementMap: Object.fromEntries(
            scenesWithVisualPrompts.map((scene) => [
              scene.sceneId,
              matchElementsToShotImage(elementsFromInput, {
                visualPrompt: visualPromptBySceneId[scene.sceneId] ?? '',
                elementTags: scene.continuity?.elementTags,
                sceneExtract: scene.originalScript.extract,
              }),
            ])
          ),
        };
      });

    const imageSize = aspectRatioToImageSize(aspectRatio);

    // Build a sceneId→snapshot index once so the per-(scene, model) inner
    // loop doesn't repeat O(snapshots) `find` work for every shot × model.
    const sceneSnapshotsById = new Map<string, ShotImageSceneSnapshot>(
      (input.sceneSnapshots ?? []).map((s) => [s.sceneId, s])
    );

    // Pre-compute every (sceneId, model) snapshot hash once and persist via
    // `step.do`. Workflow bodies replay from the top on every step callback,
    // so wrapping in `step.do` snapshots the result — replays just read the
    // persisted Record instead of re-hashing on each callback.
    const snapshotHashKey = (sceneId: string, model: string) =>
      `${sceneId}::${model}`;
    const snapshotHashByKey = await step.do(
      'compute-snapshot-hashes',
      async () => {
        const out: Record<string, string | undefined> = {};
        for (const scene of scenesWithVisualPrompts) {
          const snap = sceneSnapshotsById.get(scene.sceneId);
          for (const model of imageModels) {
            out[snapshotHashKey(scene.sceneId, model)] = snap
              ? await computeShotImageSceneHash(snap, model, aspectRatio)
              : undefined;
          }
        }
        return out;
      }
    );

    const imageBinding = this.env.IMAGE_WORKFLOW;

    // Fan out one IMAGE_WORKFLOW child per (scene, model). Wave-bounded
    // (#1126) so large sequences don't stampede isolates + D1; allSettled
    // isolation is preserved within each wave. Per-scene failures surface
    // via WorkflowValidationError below for parity with the QStash
    // `result.isFailed` check.
    // Per-scene inputs, resolved once instead of per (scene, model) job.
    // Stored as value-or-error: a scene with no visual prompt must fail only
    // its own slot, so resolving eagerly must not throw out of the batch.
    const sceneContexts = new Map<string, SceneImageContext | Error>();
    for (const scene of scenesWithVisualPrompts) {
      // The visual prompt is no longer carried on `scene.prompts` (#713); it
      // rides on the per-scene snapshot, which analyze-script populates from
      // the shot's `frame.imagePrompt` mirror. Sourcing it here keeps the
      // hashed snapshot and the rendered prompt identical by construction.
      const visualPrompt = sceneSnapshotsById.get(scene.sceneId)?.visualPrompt;
      if (!visualPrompt) {
        sceneContexts.set(
          scene.sceneId,
          new WorkflowValidationError(
            `Scene ${scene.sceneId} has no visual prompt`
          )
        );
        continue;
      }

      const characterRefs = buildCharacterReferenceImages(
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        sceneCharacterMap[scene.sceneId] || []
      );
      const locationRefs = buildLocationReferenceImages(
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        sceneLocationMap[scene.sceneId] || []
      );
      const elementRefs = buildElementReferenceImages(
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        sceneElementMap[scene.sceneId] || []
      );

      sceneContexts.set(scene.sceneId, {
        visualPrompt,
        matchedShot: shotMapping.find(
          (f) => f.analysisSceneId === scene.sceneId
        ),
        characterRefs,
        locationRefs,
        elementRefs,
        allReferences: [...characterRefs, ...locationRefs, ...elementRefs],
        // Bound to sceneId rather than index so a re-ordered `sceneSnapshots`
        // array (e.g. analyze-script sorts by sceneId; we don't) still maps
        // right.
        sceneSnapshot: sceneSnapshotsById.get(scene.sceneId),
      });
    }

    // Flatten (scene × model) so one ceiling governs the real unit of work.
    // #1126 capped scenes and then ran models one at a time inside each scene,
    // which multiplied the wave count by the model count for no extra safety.
    const jobs = scenesWithVisualPrompts.flatMap((scene, sceneIndex) =>
      imageModels.map((model) => ({
        scene,
        sceneIndex,
        model,
      }))
    );

    // Unbounded (#1143). The per-run ceiling #1126 added measured no benefit —
    // 20 concurrent sequences with the fan-out unbounded produced the same
    // hang count and the same p95 as with it capped — and it was never real
    // admission control anyway: the limit was per workflow run, so N
    // concurrent sequences multiplied straight through it. Rate limiting
    // belongs somewhere that can see the whole system, not here.
    const runImageJob = async (
      { scene, model }: (typeof jobs)[number],
      attempt: 'first' | 'retry'
    ): Promise<ShotImageJobResult> => {
      const context = sceneContexts.get(scene.sceneId);
      if (context === undefined) {
        throw new WorkflowValidationError(
          `Scene ${scene.sceneId} has no resolved image context`
        );
      }
      if (context instanceof Error) throw context;
      const {
        visualPrompt,
        matchedShot,
        characterRefs,
        locationRefs,
        elementRefs,
        allReferences,
        sceneSnapshot,
      } = context;
      const perShotSnapshotInputHash =
        snapshotHashByKey[snapshotHashKey(scene.sceneId, model)];

      const childBody: ImageWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        reservationId: input.reservationId,
        prompt: visualPrompt,
        model,
        imageSize,
        aspectRatio,
        numImages: 1,
        shotId: matchedShot?.shotId,
        // Materialized by scene-split and threaded through the mapping
        // (#991) — the child never re-resolves the anchor.
        frameId: matchedShot?.frameId ?? undefined,
        sequenceId,
        referenceImages: allReferences.length > 0 ? allReferences : undefined,
        sceneSnapshot,
        snapshotInputHash: perShotSnapshotInputHash,
      };

      // Per-spawn unique IDs. Include the model so the per-(scene,
      // model) fan-out gets distinct CF instance IDs — siblings
      // would otherwise collide on `image:${sequenceId}:${shotId}`
      // (CF instance IDs are global per Worker script). A silent retry
      // must also be a new instance — the failed child already exists.
      const retrySuffix = attempt === 'retry' ? ':retry' : '';
      const stepSuffix = attempt === 'retry' ? '-retry' : '';
      const childIdSuffix = matchedShot?.shotId
        ? `image:${sequenceId ?? 'no-seq'}:${matchedShot.shotId}:${model}${retrySuffix}`
        : `image:${sequenceId ?? 'no-seq'}:${scene.sceneId}:${model}${retrySuffix}`;

      const childOutput = await spawnAndAwaitChild<
        ImageWorkflowInput,
        ImageChildResult
      >(step, {
        binding: imageBinding,
        parentBindingName: 'SHOT_IMAGES_WORKFLOW',
        parentInstanceId,
        childId: childIdSuffix,
        childPayload: childBody,
        spawnStepName: `spawn-image-${scene.sceneId}-${model}${stepSuffix}`,
        awaitStepName: `await-image-${scene.sceneId}-${model}${stepSuffix}`,
        timeout: '30 minutes',
      });

      if (!childOutput.imageUrl) {
        throw new WorkflowValidationError(
          `Image generation failed for scene ${scene.sceneId} model ${model}`
        );
      }

      // Trigger variant (shot grid) workflow as a separate top-level
      // run. Fire-and-forget — shot-images shouldn't block on it,
      // since the variant just enriches the shot after the fact and
      // its progress is tracked independently via
      // `shot.variantImageStatus`.
      await step.do(
        `trigger-variant-${scene.sceneId}-${model}${stepSuffix}`,
        async () => {
          const enforcement =
            await scopedDb.liveRead.compliance.listEnforcementFor(
              input.userId,
              input.teamId
            );
          await triggerWorkflow<ShotVariantWorkflowInput>(
            '/variant-image',
            {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              shotId: matchedShot?.shotId,
              frameId: matchedShot?.frameId ?? undefined,
              thumbnailUrl: childOutput.imageUrl,
              scenePrompt: visualPrompt,
              characterReferences:
                characterRefs.length > 0 ? characterRefs : undefined,
              locationReferences:
                locationRefs.length > 0 ? locationRefs : undefined,
              elementReferences:
                elementRefs.length > 0 ? elementRefs : undefined,
              aspectRatio,
              model,
            },
            {
              label,
              retries: 3,
              retryDelay: 'pow(2, retried) * 1000',
              // Replay-stable: a retry of this step.do must reuse the
              // existing variant instance instead of spawning a second
              // paid job (see dedup-ids.ts).
              deduplicationId: shotVariantDedupId(
                parentInstanceId,
                matchedShot?.shotId ?? scene.sceneId,
                model
              ),
              enforcement,
            }
          );
        }
      );

      return {
        imageUrl: childOutput.imageUrl,
        frameVersionId: childOutput.frameVersionId ?? null,
      };
    };

    const jobResults: PromiseSettledResult<ShotImageJobResult>[] =
      await Promise.allSettled(jobs.map((job) => runImageJob(job, 'first')));

    // One failed primary of many is usually a transient content-flag or
    // timeout — retry it once silently so the scenes page doesn't open on
    // "Generation partially failed. 1 image failed" (#1286).
    const [primaryModel] = imageModels;
    const retryIndex =
      primaryModel === undefined
        ? null
        : loneFailedPrimaryJobIndex(jobs, jobResults, primaryModel);
    if (retryIndex !== null) {
      const retryJob = jobs[retryIndex];
      if (retryJob) {
        logger.info(
          `[ShotImagesWorkflow:cf] Silently retrying lone failed primary for scene ${retryJob.scene.sceneId} model ${retryJob.model}`
        );
        try {
          const retried = await runImageJob(retryJob, 'retry');
          jobResults[retryIndex] = {
            status: 'fulfilled',
            value: retried,
          };
        } catch (err) {
          jobResults[retryIndex] = { status: 'rejected', reason: err };
        }
      }
    }

    // Regroup the flat job results back per scene, model order preserved, so
    // the primary/alternate rule below is unchanged by the flattening.
    // `jobs` is generated scene-major with models in order, and both forEach
    // and mapWithConcurrency preserve input order, so appending here rebuilds
    // each scene's model sequence exactly.
    const modelResultsByScene = new Map<
      number,
      PromiseSettledResult<ShotImageJobResult>[]
    >();
    jobs.forEach((job, jobIndex) => {
      const result = jobResults[jobIndex];
      if (!result) return;
      const forScene = modelResultsByScene.get(job.sceneIndex) ?? [];
      forScene.push(result);
      modelResultsByScene.set(job.sceneIndex, forScene);
    });

    // Surface per-model failures. The primary (index 0) result is what
    // becomes this scene's `imageUrl`; if it failed the scene is rejected
    // for parity with the QStash original's `result.isFailed` check.
    // Sibling-model failures are logged but don't block — they're
    // alternates that enrich `shot_variants`, not the primary.
    const sceneResults: PromiseSettledResult<ShotImageJobResult>[] =
      scenesWithVisualPrompts.map((scene, sceneIndex) => {
        const modelResults = modelResultsByScene.get(sceneIndex) ?? [];
        const primary = modelResults[0];
        if (!primary) {
          return {
            status: 'rejected',
            reason: new WorkflowValidationError(
              `Primary image generation failed for scene ${scene.sceneId}: no models configured`
            ),
          };
        }
        if (primary.status === 'rejected') {
          return {
            status: 'rejected',
            reason: new WorkflowValidationError(
              `Primary image generation failed for scene ${scene.sceneId}: ${String(primary.reason)}`
            ),
          };
        }
        for (let i = 1; i < modelResults.length; i++) {
          const r = modelResults[i];
          if (r?.status === 'rejected') {
            logger.warn(
              `[ShotImagesWorkflow:cf] Alternate model ${imageModels[i]} failed for scene ${scene.sceneId}:`,
              {
                err: r.reason,
              }
            );
          }
        }
        return { status: 'fulfilled', value: primary.value };
      });

    // Collect results ALIGNED to scene order — a rejected scene keeps its
    // slot as `null` rather than being compacted out. Consumers index
    // `imageUrls` by scene position (analyze-script phase 5 pairs
    // `imageUrls[index]` with `completeScenes[index]`), so compaction shifted
    // every later image onto the wrong scene and made the trailing scene
    // throw "has no generated image URL" (June 6 sample-run failure).
    // Rejections get reported but don't kill the workflow, so a single scene
    // with no visual prompt (or a deleted shot mid-flight) can't poison the
    // rest of the batch.
    const imageUrls: (string | null)[] = sceneResults.map((r, i) => {
      if (r.status === 'fulfilled') return r.value.imageUrl;
      const scene = scenesWithVisualPrompts[i];
      logger.error(
        `[ShotImagesWorkflow:cf] Scene ${scene?.sceneId ?? '(unknown)'} failed: ${String(r.reason)}`,
        {
          err: r.reason,
        }
      );
      return null;
    });
    const frameVersionIds: (string | null)[] = sceneResults.map((r) =>
      r.status === 'fulfilled' ? r.value.frameVersionId : null
    );

    return { imageUrls, frameVersionIds };
  }

  protected override onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<ShotImagesWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    const input = event.payload;
    logger.error(
      `[ShotImagesWorkflow:cf] Shot image generation failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
