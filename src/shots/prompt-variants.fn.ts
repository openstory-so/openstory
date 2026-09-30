import { safeAudioModel } from '@/models/models';
import { saveShotPrompt } from '@/shots/server/save-shot-prompt';
import { regenerateShotPrompt } from '@/shots/server/regenerate-shot-prompt';
import { readMusicPromptStaleness } from '@/audio/server/music-staleness';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import {
  computeMusicPromptInputHash,
  musicPromptInputHashMatches,
} from './input-hash';
import {
  SHOT_PROMPT_TYPES,
  type ShotPromptVersion,
  type SequenceMusicPromptVersion,
} from '@/platform/server/db/schema';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { simpleHash } from '@/platform/hash';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { terminateSingleArtifactRun } from '@/platform/server/workflow/run-outcome';
import { storedMotionDialogueSchema } from './scene-analysis.schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { MusicPromptWorkflowInput } from '@/platform/server/workflow/types';
import { musicSceneSummariesFromRows } from '@/audio/server/workflows/music-scene-summaries';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';

import { getLogger } from '@/platform/logger';

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

/**
 * A derived row restores as derived, carrying the spec it was built from.
 * A derived row whose spec id is missing (legacy) cannot be written as
 * derived, so it restores as history. Every other source restores as history.
 */
function restoredPromptProvenance(row: {
  source: string;
  specVersionId: string | null;
}): { source: 'derived'; specVersionId: string } | { source: 'restored' } {
  if (row.source === 'derived' && row.specVersionId) {
    return { source: 'derived', specVersionId: row.specVersionId };
  }
  return { source: 'restored' };
}

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
        inputHash: frameChosen.inputHash,
        analysisModel: frameChosen.analysisModel,
        createdBy: context.user.id,
        ...restoredPromptProvenance(frameChosen),
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
      audio: chosen.audio,
      usesStartFrame: chosen.usesStartFrame,
      inputHash: chosen.inputHash,
      analysisModel: chosen.analysisModel,
      createdBy: context.user.id,
      ...restoredPromptProvenance(chosen),
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
  /**
   * Replaces the carried-forward dialogue direction on a motion save (#1559).
   * The editor sends it when the user binds a voice element to a line; every
   * other save omits it and the selected version's dialogue rides across
   * unchanged. Motion-only — a visual row has no dialogue.
   */
  dialogue: storedMotionDialogueSchema.optional(),
});

export const saveShotPromptFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotSaveInput))
  .handler(async ({ context, data }) => {
    const { scene: _scene, ...result } = await saveShotPrompt(context, data);
    return result;
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
  // `force: true` rebuilds even when the prompts read fresh. The
  // staleness-banner path leaves this unset.
  force: z.boolean().optional(),
  /** Replace this prompt even though the user wrote it (confirmed in the UI). */
  replaceWritten: z.boolean().optional(),
});

export const regenerateShotPromptFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotRegenerateInput))
  .handler(async ({ context, data }) => {
    if (!context.scene) {
      throw new Error('Shot has no scene metadata to regenerate from');
    }
    const replace = data.replaceWritten === true;
    return regenerateShotPrompt(context, context.scene, {
      force: data.force === true,
      replace: {
        visual: replace && data.promptType === 'visual',
        motion: replace && data.promptType === 'motion',
      },
    });
  });

const saveMusicPromptInput = z.object({
  sequenceId: ulidSchema,
  prompt: z.string().trim().min(1).max(5000),
  tags: z.string().trim().max(1000).optional(),
});

/**
 * Persist a hand-edited music prompt WITHOUT regenerating the track (#1108
 * Phase 4 — "editable after the track exists"). Appends a `user-edit`
 * `sequence_music_prompt_versions` row and selects it (the scoped write does
 * both). A
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

    const [shots, sceneRows] = await Promise.all([
      scopedDb.shots.listBySequence(sequence.id),
      scopedDb.scenes.listBySequence(sequence.id),
    ]);
    const { sceneSummaries, legacyShotSummaries } = musicSceneSummariesFromRows(
      sceneRows,
      shots
    );
    if (sceneSummaries.length === 0) {
      throw new Error(
        'Sequence has no scenes to regenerate the music prompt from'
      );
    }

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
      await musicPromptInputHashMatches(
        sequence.musicPromptInputHash,
        { sceneSummaries, analysisModel: analysisModelId },
        legacyShotSummaries
      )
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
        musicModel: safeAudioModel(sequence.musicModel),
      },
      {
        // Dedup by the live input hash so a retry of the same upstream context
        // collapses to one workflow run instead of N.
        deduplicationId: musicPromptDedupId(sequence.id, liveHash),
      }
    );

    return { workflowRunId, alreadyUpToDate: false } as const;
  });

export const getMusicPromptStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sequenceListInput))
  .handler(({ context }) =>
    readMusicPromptStaleness(context.scopedDb, context.sequence)
  );

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
