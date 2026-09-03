import {
  rendersReferenceOnly,
  shotPromptSequence,
  usesStartFrame,
} from '@/lib/shots/use-start-frame';
import {
  computeMotionPromptInputHash,
  computeMusicPromptInputHash,
  computeVisualPromptInputHash,
  motionPromptInputHashMatches,
  musicPromptInputHashMatches,
  visualPromptInputHashMatches,
} from '@/lib/ai/input-hash';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import {
  loadShotPromptContext,
  narrowShotPromptContext,
} from '@/lib/ai/prompt-context';
import {
  SHOT_PROMPT_TYPES,
  type ShotPromptVersion,
  type SequenceMusicPromptVersion,
} from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { getFrameImageUrl } from '@/lib/shots/frame-image';
import { simpleHash } from '@/lib/utils/hash';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { terminateSingleArtifactRun } from '@/lib/workflow/run-outcome';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  MotionPromptWorkflowInput,
  MusicPromptWorkflowInput,
  FramePromptWorkflowInput,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { shotAccessMiddleware, sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'prompt-variants']);

const promptTypeSchema = z.enum(SHOT_PROMPT_TYPES);

/**
 * Stable deduplication ID for shot-prompt regeneration. Workflow retries with
 * the same upstream context must collapse to a single run, so this string
 * cannot include timestamps or random suffixes.
 */
export function shotPromptDedupId(
  promptType: 'visual' | 'motion',
  shotId: string,
  liveHash: string
): string {
  return `prompt-${promptType}-${shotId}-${liveHash}`;
}

/**
 * Unique deduplication ID for an explicit user-driven force-regeneration.
 * Distinct from `shotPromptDedupId` because the user is asking for a fresh
 * LLM completion regardless of whether upstream inputs changed — collapsing
 * repeat clicks to one run would silently swallow the regeneration.
 */
export function shotPromptForceDedupId(
  promptType: 'visual' | 'motion',
  shotId: string,
  nonce: string
): string {
  return `prompt-${promptType}-${shotId}-force-${nonce}`;
}

/** Stable deduplication ID for music-prompt regeneration — see above. */
export function musicPromptDedupId(
  sequenceId: string,
  liveHash: string
): string {
  return `music-prompt-${sequenceId}-${liveHash}`;
}

/** True when a cached hash means there is no work for the regeneration to do. */
export function isPromptUpToDate(
  storedHash: string | null,
  liveHash: string
): boolean {
  return storedHash !== null && storedHash === liveHash;
}

// Visual prompt history now comes from `frame_prompt_versions` and motion from
// `shot_prompt_versions` (#989). Both stores are normalized to this minimal,
// store-agnostic row so `listShotPromptVariantsFn` returns one shape.
export type ShotPromptVariantWithAuthor = Pick<
  ShotPromptVersion,
  'id' | 'source' | 'text' | 'inputHash' | 'createdAt' | 'status'
> & {
  createdByName: string | null;
};

export type SequenceMusicPromptVariantWithAuthor =
  SequenceMusicPromptVersion & { createdByName: string | null };

const shotListInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  promptType: promptTypeSchema,
});

export const listShotPromptVariantsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotListInput))
  .handler(
    async ({ context, data }): Promise<ShotPromptVariantWithAuthor[]> => {
      // Visual prompt history moved to frame_prompt_versions (#989); motion
      // history stays on shot_prompt_versions. Use the resolved anchor frame id
      // (never the shot id).
      if (data.promptType === 'visual') {
        const rows =
          await context.scopedDb.framePromptVersions.listByFrameWithAuthor(
            context.frame.id
          );
        return rows.map((r) => ({
          id: r.id,
          source: r.source,
          text: r.text,
          inputHash: r.inputHash,
          createdAt: r.createdAt,
          createdByName: r.createdByName,
          status: r.status,
        }));
      }
      const rows =
        await context.scopedDb.shotPromptVersions.listByShotWithAuthor(
          data.shotId,
          data.promptType
        );
      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        text: r.text,
        inputHash: r.inputHash,
        createdAt: r.createdAt,
        createdByName: r.createdByName,
        status: r.status,
      }));
    }
  );

const sequenceListInput = z.object({ sequenceId: ulidSchema });

export const listSequenceMusicPromptVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sequenceListInput))
  .handler(
    async ({
      context,
      data,
    }): Promise<SequenceMusicPromptVariantWithAuthor[]> => {
      return await context.scopedDb.sequenceMusicPromptVersions.listBySequenceWithAuthor(
        data.sequenceId
      );
    }
  );

// Restore carries the source variant's input_hash forward so staleness keeps
// tracking the upstream context — restoring an old AI prompt without the hash
// would short-circuit the staleness check to "fresh" forever.
const shotRestoreInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  variantId: ulidSchema,
  // Which store `variantId` lives in. Explicit rather than probed: the #1067
  // backfills give a version row its parent's ULID, and #989 already made an
  // anchor frame's id equal its shot's — so one id can name a row in BOTH
  // `frame_prompt_versions` and `shot_prompt_versions`. Probing would restore
  // whichever table was checked first.
  promptType: promptTypeSchema,
});

export const restoreShotPromptVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotRestoreInput))
  .handler(async ({ context, data }) => {
    // Visual prompt history lives in frame_prompt_versions (#989); motion stays
    // on shot_prompt_versions. The caller says which — see `promptType` above.
    // Use the resolved anchor frame id (never the shot id).
    if (data.promptType === 'visual') {
      const frameChosen =
        await context.scopedDb.framePromptVersions.getByIdForFrame(
          data.variantId,
          context.frame.id
        );
      if (!frameChosen) {
        throw new Error('Prompt variant not found for this shot');
      }
      if (frameChosen.status !== 'completed') {
        // In-flight/failed placeholders have no content to restore (#1085).
        throw new Error('Cannot restore a prompt version that never completed');
      }
      const inserted = await context.scopedDb.framePromptVersions.write({
        frameId: context.frame.id,
        text: frameChosen.text,
        components: frameChosen.components,
        source: 'restored',
        inputHash: frameChosen.inputHash,
        analysisModel: frameChosen.analysisModel,
        createdBy: context.user.id,
      });
      return { variantId: inserted.id };
    }

    const chosen = await context.scopedDb.shotPromptVersions.getByIdForShot(
      data.variantId,
      data.shotId
    );
    if (!chosen) {
      throw new Error('Prompt variant not found for this shot');
    }
    if (chosen.status !== 'completed') {
      throw new Error('Cannot restore a prompt version that never completed');
    }

    const inserted = await context.scopedDb.shotPromptVersions.write({
      shotId: data.shotId,
      promptType: chosen.promptType,
      text: chosen.text,
      components: chosen.components,
      parameters: chosen.parameters,
      dialogue: chosen.dialogue,
      audio: chosen.audio,
      source: 'restored',
      usesStartFrame: chosen.usesStartFrame,
      inputHash: chosen.inputHash,
      analysisModel: chosen.analysisModel,
      createdBy: context.user.id,
    });
    return { variantId: inserted.id };
  });

const sequenceRestoreInput = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

export const restoreSequenceMusicPromptVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sequenceRestoreInput))
  .handler(async ({ context, data }) => {
    const chosen =
      await context.scopedDb.sequenceMusicPromptVersions.getByIdForSequence(
        data.variantId,
        data.sequenceId
      );
    if (!chosen) {
      throw new Error('Music prompt variant not found for this sequence');
    }

    const inserted = await context.scopedDb.sequenceMusicPromptVersions.write({
      sequenceId: data.sequenceId,
      prompt: chosen.prompt,
      tags: chosen.tags,
      source: 'restored',
      inputHash: chosen.inputHash,
      analysisModel: chosen.analysisModel,
      createdBy: context.user.id,
    });
    return { variantId: inserted.id };
  });

// Persist a hand-edited prompt as a `user-edit` version WITHOUT triggering a
// render. Until now the only persistence path for an edited prompt was clicking
// Generate/Regenerate (the render fns), so a manual edit or a "Shorten" stayed a
// local textarea draft and was silently lost on the next shot refetch. This is
// the standalone Save: it appends a `user-edit` version + mirrors it onto the
// frame/shot, matching what the image/motion workflows record for an edited
// prompt (`shouldRecordUserEdit` + upstream-hash capture) minus the render.
const shotSaveInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  promptType: promptTypeSchema,
  text: z.string().min(1),
});

export const saveShotPromptFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotSaveInput))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, scopedDb, user, scene } = context;
    const text = data.text.trim();
    if (!text) {
      throw new Error('Cannot save an empty prompt');
    }

    // No-op guard: don't append a `user-edit` identical to the live prompt —
    // mirrors `shouldRecordUserEdit` in the render workflows so a Save with no
    // actual change doesn't spawn a duplicate history row.
    const selectedMotion =
      data.promptType === 'motion'
        ? await scopedDb.shotPromptVersions.getSelectedMotion(shot.id)
        : null;
    const currentPrompt =
      data.promptType === 'visual'
        ? ((await scopedDb.framePromptVersions.getSelected(frame.id))?.text ??
          null)
        : (selectedMotion?.text ?? null);
    if (currentPrompt !== null && currentPrompt === text) {
      return { unchanged: true } as const;
    }

    // Capture the current upstream hash so staleness keeps tracking: a manual
    // edit aligns the prompt with the live context, and it should later light
    // up 'stale' if that context changes. Best-effort — a null hash just
    // disables staleness for this prompt, it never blocks the save (matches the
    // render-workflow user-edit path).
    let inputHash: string | null = null;
    let analysisModel: string | null = null;
    if (scene) {
      try {
        const ctx = await loadShotPromptContext({
          scopedDb,
          sequence: shotPromptSequence(sequence, shot),
          scene,
          // No-op for visual; the motion hash folds in the rendered still.
          startingFrameImageUrl: rendersReferenceOnly(shot, sequence)
            ? null
            : await getFrameImageUrl(scopedDb, frame.id),
        });
        const narrowed = narrowShotPromptContext(ctx);
        inputHash =
          data.promptType === 'visual'
            ? await computeVisualPromptInputHash(narrowed)
            : await computeMotionPromptInputHash(narrowed);
        analysisModel = ctx.analysisModel;
      } catch (error) {
        logger.warn(
          `saveShotPrompt: uncomputable hash for shot ${shot.id}; recording with null hash`,
          { err: error }
        );
      }
    }

    if (data.promptType === 'visual') {
      const inserted = await scopedDb.framePromptVersions.write({
        frameId: frame.id,
        text,
        source: 'user-edit',
        inputHash,
        analysisModel,
        createdBy: user.id,
      });
      return { unchanged: false, versionId: inserted.id } as const;
    }

    // Carry the selected version's dialogue/audio direction forward onto the
    // user-edit so audio-capable models keep their enrichment after a free-text
    // edit (mirrors the motion-workflow user-edit path). `components` /
    // `parameters` stay null on a hand edit.
    const inserted = await scopedDb.shotPromptVersions.write({
      shotId: shot.id,
      promptType: 'motion',
      text,
      dialogue: selectedMotion?.dialogue ?? null,
      audio: selectedMotion?.audio ?? null,
      source: 'user-edit',
      usesStartFrame: usesStartFrame(shot, sequence),
      inputHash,
      analysisModel,
      createdBy: user.id,
    });
    return { unchanged: false, versionId: inserted.id } as const;
  });

/**
 * Cancel an in-flight pending artifact claim (#1085): flip the row to
 * 'cancelled' (a completion that races in afterwards is discarded against the
 * status guard), cascade to dependent image claims, and best-effort terminate
 * the producing workflow when it's a single-artifact run. Idempotent — a row
 * that already went terminal reports `cancelled: false`.
 */
const cancelPendingInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  versionId: ulidSchema,
  artifact: z.enum(['visual-prompt', 'motion-prompt', 'image']),
});

/**
 * Settle the frame's primary in-flight state after an image claim cancel
 * (#1095 review): the producing run may be terminated (or abandon the claim
 * before its own settle path runs), which would leave `image_status` stuck
 * 'generating' with nothing in flight. Only touches the frame when THIS
 * cancelled row is what holds it — a newer kickoff's state is left alone.
 */
async function settleFrameAfterImageCancel(
  scopedDb: ScopedDb,
  frameId: string,
  row: { id: string; workflowRunId: string | null }
): Promise<void> {
  const frameNow = await scopedDb.frames.getById(frameId);
  if (!frameNow) return;
  const heldByThisRow =
    frameNow.pendingPromoteVersionId === row.id ||
    (row.workflowRunId !== null &&
      frameNow.imageWorkflowRunId === row.workflowRunId);
  if (!heldByThisRow) return;
  await scopedDb.frames.clearPendingPromoteVersionIdIf(frameId, row.id);
  if (frameNow.imageStatus === 'generating') {
    await scopedDb.frames.setImageGenerationStatus(
      frameId,
      {
        imageStatus: frameNow.selectedImageVersionId ? 'completed' : 'pending',
        imageWorkflowRunId: null,
        imageError: null,
      },
      { throwOnMissing: false }
    );
  }
}

export const cancelPendingArtifactFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(cancelPendingInput))
  .handler(async ({ context, data }) => {
    const { scopedDb, frame, shot } = context;

    if (data.artifact === 'visual-prompt') {
      const row = await scopedDb.framePromptVersions.getByIdForFrame(
        data.versionId,
        frame.id
      );
      if (!row) throw new Error('Prompt version not found for this shot');
      const cancelled = await scopedDb.framePromptVersions.markTerminal(
        row.id,
        'cancelled'
      );
      if (!cancelled) return { cancelled: false } as const;
      const cascaded = await scopedDb.frameVariants.cancelByDependency(
        row.id,
        'Upstream visual prompt was cancelled'
      );
      for (const dep of cascaded) {
        // Terminate the image child (if it has a real single-artifact run id)
        // before settling frame state — cancel should stop spend when possible.
        // Status guards still discard any completion that races past this.
        await terminateSingleArtifactRun(dep.workflowRunId);
        await settleFrameAfterImageCancel(scopedDb, dep.frameId, dep);
      }
      await terminateSingleArtifactRun(row.workflowRunId);
      return { cancelled: true } as const;
    }

    if (data.artifact === 'motion-prompt') {
      const row = await scopedDb.shotPromptVersions.getByIdForShot(
        data.versionId,
        shot.id
      );
      if (!row) throw new Error('Prompt version not found for this shot');
      const cancelled = await scopedDb.shotPromptVersions.markTerminal(
        row.id,
        'cancelled'
      );
      if (!cancelled) return { cancelled: false } as const;
      await terminateSingleArtifactRun(row.workflowRunId);
      return { cancelled: true } as const;
    }

    const row = await scopedDb.frameVariants.getById(data.versionId);
    if (!row || row.frameId !== frame.id) {
      throw new Error('Image version not found for this shot');
    }
    const cancelled = await scopedDb.frameVariants.markTerminal(
      row.id,
      'cancelled',
      'Cancelled by user'
    );
    if (!cancelled) return { cancelled: false } as const;
    await terminateSingleArtifactRun(row.workflowRunId);
    await settleFrameAfterImageCancel(scopedDb, row.frameId, row);
    return { cancelled: true } as const;
  });

const shotRegenerateInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  promptType: promptTypeSchema,
  // `force: true` bypasses the up-to-date short-circuit so the user can roll
  // the dice on a fresh non-deterministic LLM completion even when no upstream
  // inputs have changed. The staleness-banner path leaves this unset.
  force: z.boolean().optional(),
});

export const regenerateShotPromptFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotRegenerateInput))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, scopedDb, user, teamId, scene } = context;

    if (!scene) {
      throw new Error('Shot has no scene metadata to regenerate from');
    }

    const shotReferenceOnly = rendersReferenceOnly(shot, sequence);
    const ctx = await loadShotPromptContext({
      scopedDb,
      sequence: shotPromptSequence(sequence, shot),
      scene,
      // Motion prompts are conditioned on the rendered still (#929); feeding
      // its URL here keeps this regen-bail check in lockstep with the
      // generation-time stamp and the staleness verify. No-op for visual. The
      // still lives on the anchor frame's selected version now (#989/#1067).
      startingFrameImageUrl: shotReferenceOnly
        ? null
        : await getFrameImageUrl(scopedDb, frame.id),
    });

    // Bail if the cached input hash already matches the live recompute —
    // otherwise every double-click enqueues a duplicate workflow run and
    // appends a no-op `'regenerated'` history row. Hash inputs are narrowed
    // to what this shot's continuity actually references; the workflow
    // downstream still gets the full bibles for LLM context.
    //
    // `force` skips this bail so an explicit user click always reaches the
    // LLM — there's no other way to get a fresh non-deterministic completion
    // when upstream inputs are unchanged.
    const narrowed = narrowShotPromptContext(ctx);
    const liveHash =
      data.promptType === 'visual'
        ? await computeVisualPromptInputHash(narrowed)
        : await computeMotionPromptInputHash(narrowed);
    const storedHash =
      data.promptType === 'visual'
        ? ((await scopedDb.framePromptVersions.getSelected(frame.id))
            ?.inputHash ?? null)
        : ((await scopedDb.shotPromptVersions.getSelectedMotion(shot.id))
            ?.inputHash ?? null);
    if (
      !data.force &&
      (data.promptType === 'visual'
        ? await visualPromptInputHashMatches(storedHash, narrowed)
        : await motionPromptInputHashMatches(storedHash, narrowed))
    ) {
      return {
        workflowRunId: null,
        alreadyUpToDate: true,
        alreadyInFlight: false,
      } as const;
    }

    // Server-side dedup (#1085): a live pending claim for exactly these
    // inputs means a run is already producing this prompt — a second click,
    // a second tab, or a teammate must no-op instead of double-spending.
    // Applies to `force` too: force bypasses the up-to-date bail, not an
    // in-flight run.
    const existingClaim =
      data.promptType === 'visual'
        ? await scopedDb.framePromptVersions.getLivePending(frame.id, liveHash)
        : await scopedDb.shotPromptVersions.getLivePending(shot.id, liveHash);
    if (existingClaim) {
      return {
        workflowRunId: existingClaim.workflowRunId,
        alreadyUpToDate: false,
        alreadyInFlight: true,
      } as const;
    }

    // Pre-create the pending version row (#1085) so in-flight work is
    // representable: staleness reads 'updating', duplicate enqueues no-op,
    // and the run completes this row in place. The partial unique index on
    // live claims closes the check-then-insert race above — the loser lands
    // here and reports in-flight instead of double-spending.
    let claim;
    try {
      claim =
        data.promptType === 'visual'
          ? await scopedDb.framePromptVersions.createPending({
              frameId: frame.id,
              pendingInputHash: liveHash,
              createdBy: user.id,
            })
          : await scopedDb.shotPromptVersions.createPending({
              shotId: shot.id,
              pendingInputHash: liveHash,
              usesStartFrame: usesStartFrame(shot, sequence),
              createdBy: user.id,
            });
    } catch (error) {
      const racedClaim =
        data.promptType === 'visual'
          ? await scopedDb.framePromptVersions.getLivePending(
              frame.id,
              liveHash
            )
          : await scopedDb.shotPromptVersions.getLivePending(shot.id, liveHash);
      if (!racedClaim) throw error;
      return {
        workflowRunId: racedClaim.workflowRunId,
        alreadyUpToDate: false,
        alreadyInFlight: true,
      } as const;
    }

    // Always stream deltas for this endpoint — it's only invoked from the
    // shot inspector (stale banner or force regenerate), so a viewer is
    // watching. Binding emitStreaming to `force` alone left the stale-banner
    // path silent (no shotPrompt.streaming events → textarea never updates).
    // Fields common to both prompt workflows. The two trigger calls below build
    // their input in a NARROWED, per-type block (not a `A | B` union) so the
    // compiler enforces each workflow's required fields — a union literal only
    // has to satisfy ONE member, which is exactly how the missing-`frameId` bug
    // slipped through (FramePromptWorkflowInput needs it, MotionPromptWorkflowInput
    // doesn't, so the union accepted the omission).
    const commonInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      shotId: shot.id,
      scene,
      aspectRatio: sequence.aspectRatio,
      resolution: sequence.resolution,
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
      emitStreaming: true,
    };

    // Force-regen needs a unique dedup ID per click so the workflow trigger
    // doesn't collapse repeat clicks into a single run — the user is explicitly
    // asking for another LLM completion. The auto-staleness path keeps the stable
    // hash-based ID so genuine retries collapse to one run.
    const deduplicationId = data.force
      ? shotPromptForceDedupId(
          data.promptType,
          shot.id,
          `${Date.now()}-${crypto.randomUUID()}`
        )
      : shotPromptDedupId(data.promptType, shot.id, liveHash);
    const triggerOpts = {
      deduplicationId,
      label: buildWorkflowLabel(sequence.id),
    };

    // Neighbour scenes give the motion LLM the same continuity context the
    // analysis batch pipeline passes via MotionPromptBatchWorkflow (#929).
    let sceneBefore: Scene | undefined;
    let sceneAfter: Scene | undefined;
    if (data.promptType === 'motion') {
      const shotsInSeq = await scopedDb.shots.listBySequence(sequence.id);
      const idx = shotsInSeq.findIndex((s) => s.id === shot.id);
      const prevShot = idx > 0 ? shotsInSeq[idx - 1] : undefined;
      const nextShot =
        idx >= 0 && idx < shotsInSeq.length - 1
          ? shotsInSeq[idx + 1]
          : undefined;
      const sceneContext = await loadSceneContextBySequence(
        scopedDb,
        sequence.id
      );
      sceneBefore = prevShot
        ? (resolveSceneForShot(prevShot, sceneContext).scene ?? undefined)
        : undefined;
      sceneAfter = nextShot
        ? (resolveSceneForShot(nextShot, sceneContext).scene ?? undefined)
        : undefined;
    }

    let workflowRunId: string;
    try {
      workflowRunId =
        data.promptType === 'visual'
          ? // `frameId` is REQUIRED on FramePromptWorkflowInput — the workflow
            // never reads the DB (#991) and persists the visual prompt only
            // when it's present, so resolving the anchor frame here (from the
            // access middleware's `frame`) is mandatory, not optional.
            await triggerWorkflow<FramePromptWorkflowInput>(
              '/frame-prompt',
              {
                ...commonInput,
                frameId: frame.id,
                targetVersionId: claim.id,
              },
              triggerOpts
            )
          : // Snapshot the rendered still at trigger time (#929) so the motion
            // workflow never looks it up mid-run (a concurrent re-render could
            // swap it). The still lives on the anchor frame's selected
            // version now (#989/#1067).
            await triggerWorkflow<MotionPromptWorkflowInput>(
              '/motion-prompt',
              {
                ...commonInput,
                startingFrameImageUrl: shotReferenceOnly
                  ? null
                  : await getFrameImageUrl(scopedDb, frame.id),
                // The mode picks which motion-prompt template writes this
                // version; the hash the bail check above computed folded it in
                // through the sequence row, so it has to reach the child too or
                // the stamp and the verify disagree.
                referenceOnly: shotReferenceOnly,
                sceneBefore,
                sceneAfter,
                targetVersionId: claim.id,
              },
              triggerOpts
            );
    } catch (error) {
      // The claim must not outlive a trigger that never happened.
      if (data.promptType === 'visual') {
        await scopedDb.framePromptVersions.markTerminal(claim.id, 'failed');
      } else {
        await scopedDb.shotPromptVersions.markTerminal(claim.id, 'failed');
      }
      throw error;
    }

    // Stamp the producing instance so cancel + zombie reconciliation can
    // verify the run. 'generating' from here on — the instance starts
    // immediately.
    if (data.promptType === 'visual') {
      await scopedDb.framePromptVersions.markGenerating(
        claim.id,
        workflowRunId
      );
    } else {
      await scopedDb.shotPromptVersions.markGenerating(claim.id, workflowRunId);
    }

    return {
      workflowRunId,
      alreadyUpToDate: false,
      alreadyInFlight: false,
    } as const;
  });

const saveMusicPromptInput = z.object({
  sequenceId: ulidSchema,
  prompt: z.string().trim().min(1).max(5000),
  tags: z.string().trim().max(1000).optional(),
});

/**
 * Persist a hand-edited music prompt WITHOUT regenerating the track (#1108
 * Phase 4 — "editable after the track exists"). Appends a `user-edit`
 * `sequence_music_prompt_versions` row and mirrors it onto
 * `sequences.musicPrompt`/`musicTags` (the scoped write does both). A
 * user-edit carries no upstream hash, so music-prompt staleness reads
 * 'untracked' until the next AI regeneration — never falsely fresh or stale.
 * The existing track keeps playing; whether it matches the new prompt is the
 * user's call (Generate music re-renders on demand — no forced regen).
 */
export const saveMusicPromptFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(saveMusicPromptInput))
  .handler(async ({ context, data }) => {
    const { sequence, scopedDb, user } = context;
    const nextTags = data.tags ?? sequence.musicTags ?? null;
    if (
      data.prompt === (sequence.musicPrompt ?? '') &&
      nextTags === (sequence.musicTags ?? null)
    ) {
      return { unchanged: true } as const;
    }
    const version = await scopedDb.sequenceMusicPromptVersions.write({
      sequenceId: sequence.id,
      prompt: data.prompt,
      tags: nextTags,
      source: 'user-edit',
      createdBy: user.id,
    });
    await scopedDb.sequenceEvents.record({
      sequenceId: sequence.id,
      actorId: user.id,
      kind: 'music-prompt.edited',
      targetType: 'sequence',
      targetId: sequence.id,
      summary: 'Edited music prompt',
      data: {
        versionId: version.id,
        prevState: {
          prompt: sequence.musicPrompt ?? null,
          tags: sequence.musicTags ?? null,
        },
      },
    });
    return { unchanged: false, versionId: version.id } as const;
  });

const sequenceRegenerateInput = z.object({ sequenceId: ulidSchema });

export const regenerateMusicPromptFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sequenceRegenerateInput))
  .handler(async ({ context }) => {
    const { sequence, scopedDb, user, teamId } = context;

    const [shots, sceneContext] = await Promise.all([
      scopedDb.shots.listBySequence(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
    ]);
    const scenes = shots
      .map((shot) => resolveSceneForShot(shot, sceneContext).scene)
      .filter((scene): scene is Scene => scene !== null);
    if (scenes.length === 0) {
      throw new Error(
        'Sequence has no scenes to regenerate the music prompt from'
      );
    }
    const sceneSummaries = buildMusicSceneSummaries(scenes);

    const analysisModelId =
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL;

    // Bail if nothing has changed since the cached hash was written —
    // otherwise every double-click enqueues a duplicate workflow run.
    const liveHash = await computeMusicPromptInputHash({
      sceneSummaries,
      analysisModel: analysisModelId,
    });
    if (
      await musicPromptInputHashMatches(sequence.musicPromptInputHash, {
        sceneSummaries,
        analysisModel: analysisModelId,
      })
    ) {
      return { workflowRunId: null, alreadyUpToDate: true } as const;
    }

    const workflowRunId = await triggerWorkflow<MusicPromptWorkflowInput>(
      '/music-prompt',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneSummaries,
        analysisModelId,
        // Provenance snapshotted here: a prompt already on the sequence makes
        // this a regeneration.
        promptSource: sequence.musicPrompt ? 'regenerated' : 'ai-generated',
      },
      {
        // Dedup by the live input hash so a retry of the same upstream context
        // collapses to one workflow run instead of N.
        deduplicationId: musicPromptDedupId(sequence.id, liveHash),
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, alreadyUpToDate: false } as const;
  });

export const getMusicPromptStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sequenceListInput))
  .handler(async ({ context }) => {
    const { sequence, scopedDb } = context;

    // Mid-run (#1121): the hash is taken over the scene summaries, and a
    // storyboard run is still writing scenes — the divergence is the pipeline
    // working, not the user's edit. Same short-circuit as
    // `computeShotStaleness`, for the same reason: no verdict while the
    // sequence is being built.
    if (sequence.status === 'processing') {
      return { musicPrompt: 'generating' as const };
    }

    // No stored hash: legacy sequence or never generated. Surface explicitly
    // so the UI can suppress the "regenerate" prompt without claiming
    // freshness.
    if (!sequence.musicPromptInputHash) {
      return { musicPrompt: 'untracked' as const };
    }

    try {
      const [shots, sceneContext] = await Promise.all([
        scopedDb.shots.listBySequence(sequence.id),
        loadSceneContextBySequence(scopedDb, sequence.id),
      ]);
      const scenes = shots
        .map((shot) => resolveSceneForShot(shot, sceneContext).scene)
        .filter((scene): scene is Scene => scene !== null);
      if (scenes.length === 0) {
        return { musicPrompt: 'untracked' as const };
      }
      const sceneSummaries = buildMusicSceneSummaries(scenes);

      const latest = await scopedDb.sequenceMusicPromptVersions.getLatest(
        sequence.id
      );
      const analysisModel =
        latest?.analysisModel ??
        getAnalysisModelById(sequence.analysisModel)?.id ??
        DEFAULT_ANALYSIS_MODEL;

      const musicUpToDate = await musicPromptInputHashMatches(
        sequence.musicPromptInputHash,
        { sceneSummaries, analysisModel }
      );

      return {
        musicPrompt: musicUpToDate ? ('fresh' as const) : ('stale' as const),
      };
    } catch (error) {
      // Hash uncomputable (e.g., scene metadata missing a required field).
      // Surface as untracked so the UI doesn't lie about freshness.
      logger.warn(`uncomputable for sequence ${sequence.id}:`, { err: error });
      return { musicPrompt: 'untracked' as const };
    }
  });

// Variant `promptHash` is `simpleHash(text)` (32-bit, non-crypto). We match
// against prompt-variant rows that existed at or before the variant's
// `createdAt` to recover the prompt that produced it.
const variantPromptDiffInput = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

export type VariantPromptDiff = {
  label: string;
  before: string;
  after: string;
} | null;

export const getDivergentVariantPromptDiffFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantPromptDiffInput))
  .handler(async ({ context, data }): Promise<VariantPromptDiff> => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant) return null;
    // Auth boundary: don't silently collapse cross-sequence access into a
    // 'no diff' return — that would mask an authorization bug.
    if (variant.sequenceId !== data.sequenceId) {
      throw new Error('Variant does not belong to this sequence');
    }
    // No diff to render: legacy variant without a prompt snapshot, or audio
    // variants which have no field-level prompt diff.
    if (!variant.promptHash) return null;
    if (variant.variantType === 'audio') return null;
    // Image variants moved to frame_variants (#989); `shot_variants` only holds
    // video/audio now, so the only field-level prompt diff here is motion. (An
    // image variant id never resolves via `shotVariants.getById`.)
    if (variant.variantType === 'image') return null;

    const candidates =
      await context.scopedDb.shotPromptVersions.listCandidatesAtOrBefore(
        variant.shotId,
        'motion',
        variant.createdAt
      );

    const matched = candidates.find(
      (c) => simpleHash(c.text) === variant.promptHash
    );
    if (!matched) {
      // Hash chain broken — the prompt that produced this variant has been
      // pruned or never recorded. Log so operations notices history loss
      // instead of silently rendering an empty diff dialog.
      logger.warn(`no candidate prompt matched ${variant.id}`);
      return null;
    }

    const [shotRow] = await context.scopedDb.shots.getByIds([variant.shotId]);
    if (!shotRow) {
      // FK invariant violation — variant references a shot that no longer
      // exists.
      throw new Error(
        `Shot ${variant.shotId} missing for variant ${variant.id}`
      );
    }
    const live = (
      await context.scopedDb.shotPromptVersions.getSelectedMotion(
        variant.shotId
      )
    )?.text;
    if (!live) return null;
    if (live === matched.text) return null;

    return {
      label: 'Motion prompt',
      before: matched.text,
      after: live,
    };
  });
