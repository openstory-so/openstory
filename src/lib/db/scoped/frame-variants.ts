/**
 * Scoped Frame Variants Sub-module (flat, append-only image versions).
 *
 * Each row is ONE image generation — a *version*. A "variant" is the emergent
 * group of rows sharing `(frameId, kind, model, sourceVariantId)`; its
 * "versions" are those rows ordered by time (ULID). Re-rolls **accumulate** —
 * append never overwrites, so a video render manifest can reference a version
 * id as a stable snapshot.
 *
 * **Selection is a pointer, not a per-row flag.** The frame's current image is
 * whichever version `frames.selectedImageVersionId` points at; revert /
 * switch-model is a {@link select} repoint. `discardedAt` soft-hides a version
 * (undoable); there is no `divergedAt` (retired in the redesign).
 *
 * Every mutation commits its state change (the pointer repoint for
 * {@link select}, the `discardedAt` write for discard / undiscard) and its
 * `sequence_events` row in the SAME `db.batch()` (see {@link buildEventInsert}),
 * so the change and its activity entry are atomic.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { framePromptVersions, frameVariants, frames } from '@/lib/db/schema';
import type {
  FramePromptVersion,
  FrameVariant,
  NewFrameVariant,
} from '@/lib/db/schema';
import {
  type FrameVariantKind,
  isSelectableFrameVariantKind,
} from '@/lib/db/schema/frame-variants';
import { simpleHash } from '@/lib/utils/hash';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
} from 'drizzle-orm';
import { LIVE_PENDING_STATUSES } from './frame-prompt-versions';
import {
  buildFrameImageSelection,
  type PromotableFrameVariant,
} from './frames';
import { buildEventInsert } from './sequence-events';

function readStringProp(value: object, key: string): string | null {
  if (!(key in value)) return null;
  // Reflect.get avoids a typed assertion on an open object bag.
  const prop = Reflect.get(value, key);
  return typeof prop === 'string' ? prop : null;
}

/**
 * D1 / SQLite unique-index violation. Drizzle wraps the driver error in
 * `DrizzleQueryError` ("Failed query: …"), so walk `cause` and check `code`.
 */
function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 6 && current != null; i++) {
    if (current instanceof Error) {
      if (/unique|constraint|SQLITE_CONSTRAINT/i.test(current.message)) {
        return true;
      }
      const code = readStringProp(current, 'code');
      if (code && /UNIQUE|CONSTRAINT/i.test(code)) return true;
      current = current.cause;
      continue;
    }
    if (typeof current === 'object') {
      const code = readStringProp(current, 'code');
      if (code && /UNIQUE|CONSTRAINT/i.test(code)) return true;
      const message = readStringProp(current, 'message');
      if (message && /unique|constraint|SQLITE_CONSTRAINT/i.test(message)) {
        return true;
      }
      current = Reflect.get(current, 'cause');
      continue;
    }
    if (
      typeof current === 'string' &&
      /unique|constraint|SQLITE_CONSTRAINT/i.test(current)
    ) {
      return true;
    }
    break;
  }
  return false;
}

/**
 * An image `FrameVariant` plus the id of the shot whose anchor frame owns it.
 * Frame ids are NOT shot ids (#989), so sequence-wide listings that the client
 * keys by shot (coverage markers, per-shot variant filtering) carry the owning
 * `shotId` explicitly rather than reusing `frameId`.
 */
export type ImageVariantWithShot = FrameVariant & { shotId: string };

/** The grouping key that makes a flat row set read as a "variant". */
type VariantGroup = {
  frameId: string;
  kind: FrameVariantKind;
  model: string;
  /** Only for `kind: 'framing'` rows — the model image the 3×3 came from. */
  sourceVariantId?: string | null;
};

/**
 * Chronological order for this table. `id` ALONE IS NOT SAFE here: 1355 legacy
 * rows from the QStash era carry 26-char hex ids instead of ULIDs (#1132), so
 * they sort arbitrarily against every ULID — one beginning `ff` outranks every
 * id ever minted. `createdAt` is populated and correct on every row including
 * those, and `id` breaks same-second ties, which is the ordering ULIDs already
 * give within a second.
 *
 * Every "newest version wins" read in this module depends on this being right;
 * #1131 is what it looks like when it isn't.
 */
const newestFirst = [desc(frameVariants.createdAt), desc(frameVariants.id)];
const oldestFirst = [asc(frameVariants.createdAt), asc(frameVariants.id)];

// One bound param per frame, so chunk below D1's 100-param ceiling — this runs
// on the shots read path with every anchor frame of a sequence (matches
// VIDEO_BY_SHOTS_BATCH). Unit tests run on libsql, which has no such cap, so an
// unchunked list passes CI and throws on D1 (#1019).
const PREVIEW_BY_FRAMES_BATCH = 90;

/**
 * Versions by id, keyed by `id`. Chunked under D1's 100-param ceiling — the
 * shots list loads every in-flight pending-promote this way.
 */
export async function getFrameVariantsByIds(
  db: Database,
  versionIds: string[]
): Promise<Map<string, FrameVariant>> {
  if (versionIds.length === 0) return new Map();
  const byId = new Map<string, FrameVariant>();
  for (let i = 0; i < versionIds.length; i += PREVIEW_BY_FRAMES_BATCH) {
    const rows = await db
      .select()
      .from(frameVariants)
      .where(
        inArray(
          frameVariants.id,
          versionIds.slice(i, i + PREVIEW_BY_FRAMES_BATCH)
        )
      );
    for (const row of rows) byId.set(row.id, row);
  }
  return byId;
}

/**
 * Newest non-discarded `kind: 'preview'` version per frame (#1101), keyed by
 * frameId. Frames with no preview are absent, so `map.get(id) ?? null` matches
 * the single-frame read.
 *
 * Module-level (like `getPrimaryVideoByShotIds`) because the shared `ShotView`
 * query shape resolves it as a follow-up read: newest-per-frame is a group-wise
 * max, not a pointer hop, so it cannot ride the join.
 */
export async function getLatestPreviewByFrameIds(
  db: Database,
  frameIds: string[]
): Promise<Map<string, FrameVariant>> {
  if (frameIds.length === 0) return new Map();
  // asc by id (≈ time) → last write per frame wins. Chunking is safe for this
  // reduction: a frame's rows never span two batches (batches partition by
  // frame id), so per-frame ordering is preserved.
  const byFrame = new Map<string, FrameVariant>();
  for (let i = 0; i < frameIds.length; i += PREVIEW_BY_FRAMES_BATCH) {
    const rows = await db
      .select()
      .from(frameVariants)
      .where(
        and(
          inArray(
            frameVariants.frameId,
            frameIds.slice(i, i + PREVIEW_BY_FRAMES_BATCH)
          ),
          eq(frameVariants.kind, 'preview'),
          // A preview with no url is not a preview. `status` alone is NOT
          // enough: the #1101 reclassify retagged url-less rows regardless of
          // status, and 2150 of them were already 'completed'. Those carry
          // real ULIDs (`01…`) while the backfilled rows carry synthetic `00…`
          // ids, so a husk outranks the row holding the actual image and the
          // preview reads as absent — which is exactly what happened to 2150
          // of 3009 frames in production.
          eq(frameVariants.status, 'completed'),
          isNotNull(frameVariants.url),
          isNull(frameVariants.discardedAt)
        )
      )
      .orderBy(...oldestFirst);
    for (const row of rows) byFrame.set(row.frameId, row);
  }
  return byFrame;
}

export function createFrameVariantsMethods(db: Database) {
  const methods = {
    getById: async (versionId: string): Promise<FrameVariant | null> => {
      const result = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      return result[0] ?? null;
    },

    getByIds: (versionIds: string[]) => getFrameVariantsByIds(db, versionIds),

    /**
     * Append a new version row. Pure append — even when the inputs match an
     * existing version (a deliberate re-roll), a fresh row is created so the
     * history accumulates.
     *
     * The ONE exception is an in-flight append (`status: 'generating'` with a
     * `workflowRunId`): these are written inside multi-write workflow steps
     * (image `set-generating-status`, legacy upscale payloads that mint in
     * `upscale-image`), so a Cloudflare step retry after a partial failure
     * would otherwise append a SECOND orphan 'generating' row for the same
     * run. We make that idempotent on `(frameId, workflowRunId)` — re-rolls
     * are unaffected because each carries a fresh `workflowRunId`; only a
     * retry of the same run reuses its row. Current upscale triggers mint
     * the version at click and pass `versionId`; they never hit this path.
     */
    appendVersion: async (data: NewFrameVariant): Promise<FrameVariant> => {
      if (data.status === 'generating' && data.workflowRunId) {
        const [existing] = await db
          .select()
          .from(frameVariants)
          .where(
            and(
              eq(frameVariants.frameId, data.frameId),
              eq(frameVariants.workflowRunId, data.workflowRunId),
              eq(frameVariants.status, 'generating')
            )
          );
        if (existing) return existing;
      }
      const [version] = await db.insert(frameVariants).values(data).returning();
      if (!version) {
        throw new Error(
          `Failed to append frame variant for frame ${data.frameId}`
        );
      }
      return version;
    },

    /**
     * Append a user-uploaded still as a completed `kind:'upload'` version
     * (#1108 §4.3 B), committing the row and its `image.uploaded` event in one
     * `db.batch()`. Selection is the caller's next step (`select`), so the
     * upload lands in history exactly like a finished generation and the
     * repoint keeps the setImageFromVariantFn semantics (mirror + event +
     * pending-promote clear + prompt pairing).
     *
     * `inputHash` must be stamped from the CURRENT selected prompt + sheets
     * (same builder as the image workflow — see §8 "hash stamp consistency"),
     * or null when the frame has no prompt yet (staleness reads 'untracked').
     */
    appendUploadedVersion: async (input: {
      frameId: string;
      sequenceId: string;
      model: string;
      url: string;
      storagePath: string;
      inputHash: string | null;
      /** Selected prompt version the hash was computed against, if any. */
      promptVersionId: string | null;
      /** Text of that prompt (for the promptHash pairing column). */
      promptText: string | null;
      actorId: string | null;
    }): Promise<FrameVariant> => {
      const versionId = generateId();
      const [inserted] = await db.batch([
        db
          .insert(frameVariants)
          .values({
            id: versionId,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
            kind: 'upload',
            model: input.model,
            url: input.url,
            storagePath: input.storagePath,
            status: 'completed',
            generatedAt: new Date(),
            inputHash: input.inputHash,
            promptHash: input.promptText ? simpleHash(input.promptText) : null,
            promptVersionId: input.promptVersionId,
          })
          .returning(),
        buildEventInsert(db, {
          sequenceId: input.sequenceId,
          actorId: input.actorId,
          kind: 'image.uploaded',
          targetType: 'frame',
          targetId: input.frameId,
          summary: 'Uploaded still image',
          data: { versionId, promptVersionId: input.promptVersionId },
        }),
      ]);
      const version = inserted[0];
      if (!version) {
        throw new Error(
          `Failed to append uploaded frame variant for frame ${input.frameId}`
        );
      }
      return version;
    },

    /**
     * Atomic prompt + still replace (#1108 §4.3 C): append a `user-edit`
     * prompt version AND a `kind:'upload'` image version whose `inputHash`
     * was computed against the NEW prompt text, repoint BOTH selection
     * pointers, and log the events — all in ONE `db.batch()`, so the image
     * can never be observed stale relative to the prompt it was uploaded
     * with. Video is "cleared" by derivation: the render manifest still
     * references the previous frame version, so segment staleness flips.
     *
     * Mirrors the union of `framePromptVersions.write` (mirror + live-claim
     * demotion — the explicit repoint revokes in-flight prompt claims' mirror
     * rights, #1085) and `select` (image mirror + pending-promote clear).
     */
    replaceContent: async (input: {
      frameId: string;
      sequenceId: string;
      actorId: string | null;
      prompt: {
        text: string;
        /** Current upstream-context hash; null when uncomputable (matches saveShotPromptFn). */
        inputHash: string | null;
        analysisModel: string | null;
        createdBy: string | null;
      };
      image: {
        model: string;
        url: string;
        storagePath: string;
        /** Hash computed from the NEW prompt text + current sheets. */
        inputHash: string | null;
      };
    }): Promise<{
      promptVersion: FramePromptVersion;
      imageVersion: FrameVariant;
    }> => {
      const [frame] = await db
        .select({
          id: frames.id,
          prevImageVersionId: frames.selectedImageVersionId,
          prevPromptVersionId: frames.selectedImagePromptVersionId,
        })
        .from(frames)
        .where(eq(frames.id, input.frameId));
      if (!frame) {
        throw new Error(`Frame ${input.frameId} not found`);
      }

      const promptVersionId = generateId();
      const imageVersionId = generateId();
      const now = new Date();

      const [promptRows, imageRows] = await db.batch([
        db
          .insert(framePromptVersions)
          .values({
            id: promptVersionId,
            frameId: input.frameId,
            text: input.prompt.text,
            source: 'user-edit',
            status: 'completed',
            inputHash: input.prompt.inputHash,
            analysisModel: input.prompt.analysisModel,
            createdBy: input.prompt.createdBy,
          })
          .returning(),
        db
          .insert(frameVariants)
          .values({
            id: imageVersionId,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
            kind: 'upload',
            model: input.image.model,
            url: input.image.url,
            storagePath: input.image.storagePath,
            status: 'completed',
            generatedAt: now,
            inputHash: input.image.inputHash,
            promptHash: simpleHash(input.prompt.text),
            promptVersionId,
          })
          .returning(),
        db
          .update(frames)
          .set({
            selectedImagePromptVersionId: promptVersionId,
            selectedImageVersionId: imageVersionId,
            imageStatus: 'completed',
            imageError: null,
            pendingPromoteVersionId: null,
            updatedAt: now,
          })
          .where(eq(frames.id, input.frameId)),
        db
          .update(framePromptVersions)
          .set({ pendingInputHash: null })
          .where(
            and(
              eq(framePromptVersions.frameId, input.frameId),
              inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
            )
          ),
        buildEventInsert(db, {
          sequenceId: input.sequenceId,
          actorId: input.actorId,
          kind: 'prompt.edited',
          targetType: 'frame',
          targetId: input.frameId,
          summary: 'Replaced image prompt with upload',
          data: {
            versionId: promptVersionId,
            prevVersionId: frame.prevPromptVersionId ?? null,
            fromImageVersionId: imageVersionId,
          },
        }),
        buildEventInsert(db, {
          sequenceId: input.sequenceId,
          actorId: input.actorId,
          kind: 'image.uploaded',
          targetType: 'frame',
          targetId: input.frameId,
          summary: 'Uploaded still image with new prompt',
          data: {
            versionId: imageVersionId,
            prevVersionId: frame.prevImageVersionId ?? null,
            promptVersionId,
          },
        }),
        // The repoint above is a selection move, so it logs one too — the
        // activity timeline reads pointer history off `image.selected`, and
        // without it this path's move is invisible there (every other repoint
        // goes through `select`, which emits it).
        buildEventInsert(db, {
          sequenceId: input.sequenceId,
          actorId: input.actorId,
          kind: 'image.selected',
          targetType: 'frame',
          targetId: input.frameId,
          summary: 'Selected uploaded image',
          data: {
            versionId: imageVersionId,
            model: input.image.model,
            prevVersionId: frame.prevImageVersionId ?? null,
            promptVersionId,
            prevPromptVersionId: frame.prevPromptVersionId ?? null,
          },
        }),
      ]);
      const promptVersion = promptRows[0];
      const imageVersion = imageRows[0];
      if (!promptVersion || !imageVersion) {
        throw new Error(
          `Failed to replace content for frame ${input.frameId} (batch returned no rows)`
        );
      }
      return { promptVersion, imageVersion };
    },

    /**
     * Mark any still-'generating' version for a workflow run as failed. Used by
     * the image workflow's `onFailure`, which only has the run id (not the
     * version id minted in the generating step).
     */
    markFailedByWorkflowRun: async (
      workflowRunId: string,
      error: string
    ): Promise<void> => {
      // 'pending' included since #1085: a pre-created claim row whose run died
      // before reaching `set-generating-status` must not stay live forever.
      await db
        .update(frameVariants)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(
          and(
            eq(frameVariants.workflowRunId, workflowRunId),
            inArray(frameVariants.status, [...LIVE_PENDING_STATUSES])
          )
        );
    },

    /**
     * Pre-create a claim row for an enqueued image regeneration (#1085).
     * Direct regens carry `pendingInputHash` (the live hash the render will
     * satisfy); chained regens (image waiting on a pending visual-prompt row)
     * carry `dependsOnVersionId` instead — their validity derives from the
     * dependency. The producing workflow completes this row in place.
     */
    createPendingClaim: async (input: {
      frameId: string;
      sequenceId: string;
      model: string;
      pendingInputHash?: string | null;
      dependsOnVersionId?: string | null;
      workflowRunId?: string | null;
      promptVersionId?: string | null;
    }): Promise<FrameVariant> => {
      const [row] = await db
        .insert(frameVariants)
        .values({
          frameId: input.frameId,
          sequenceId: input.sequenceId,
          kind: 'model',
          model: input.model,
          status: 'pending',
          pendingInputHash: input.pendingInputHash ?? null,
          dependsOnVersionId: input.dependsOnVersionId ?? null,
          workflowRunId: input.workflowRunId ?? null,
          promptVersionId: input.promptVersionId ?? null,
        })
        .returning();
      if (!row) {
        throw new Error(
          `Failed to insert pending image claim for frame ${input.frameId}`
        );
      }
      return row;
    },

    /**
     * Record the pre-prompt stand-in for a frame (#1101): a `kind: 'preview'`
     * row holding the raw fal CDN url the preview render returned. Keyed by the
     * scene text it was rendered from (`promptHash`) — never by a prompt
     * version, because a preview exists precisely BEFORE one does.
     *
     * `storagePath` stays null on purpose: the preview path skips the R2 upload
     * to keep the progressive reveal fast (#1091), so the url expires. That is
     * harmless only because this row is never selectable, never promotable and
     * never snapshotted — it just has to outlive the window before the real
     * still lands.
     *
     * Idempotent on `(frameId, workflowRunId)`: this is written inside a
     * workflow step, and a Cloudflare step retry after a partial failure would
     * otherwise append a second preview for the same run.
     */
    recordPreview: async (input: {
      frameId: string;
      sequenceId: string;
      model: string;
      url: string;
      promptHash: string | null;
      workflowRunId: string;
    }): Promise<FrameVariant> => {
      const [existing] = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, input.frameId),
            eq(frameVariants.kind, 'preview'),
            eq(frameVariants.workflowRunId, input.workflowRunId)
          )
        );
      if (existing) return existing;
      const [row] = await db
        .insert(frameVariants)
        .values({
          frameId: input.frameId,
          sequenceId: input.sequenceId,
          kind: 'preview',
          model: input.model,
          url: input.url,
          storagePath: null,
          status: 'completed',
          generatedAt: new Date(),
          promptHash: input.promptHash,
          promptVersionId: null,
          workflowRunId: input.workflowRunId,
        })
        .returning();
      if (!row) {
        throw new Error(
          `Failed to record preview variant for frame ${input.frameId}`
        );
      }
      return row;
    },

    /**
     * Live (pending/generating) CLAIM rows for a frame — rows enqueued with a
     * pending hash or a dependency edge. Ordinary in-flight renders without a
     * claim (e.g. variant-only adds) are excluded: they don't participate in
     * staleness. Newest first.
     */
    listLiveClaims: async (frameId: string): Promise<FrameVariant[]> => {
      return await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            inArray(frameVariants.status, [...LIVE_PENDING_STATUSES]),
            isNull(frameVariants.discardedAt),
            or(
              isNotNull(frameVariants.pendingInputHash),
              isNotNull(frameVariants.dependsOnVersionId)
            )
          )
        )
        .orderBy(...newestFirst);
    },

    /**
     * Guarded claim → 'generating' transition for a pre-created row (#1085):
     * stamps the working instance, the resolved model, the prompt-version
     * pairing, and (when known) the snapshot hash the render satisfies.
     * Returns null when the claim went terminal meanwhile (user cancel won
     * the race) — the caller must abandon the render.
     */
    claimForGeneration: async (
      versionId: string,
      data: {
        workflowRunId: string;
        model: string;
        promptVersionId?: string | null;
        pendingInputHash?: string | null;
      }
    ): Promise<FrameVariant | null> => {
      try {
        const [row] = await db
          .update(frameVariants)
          .set({
            status: 'generating',
            workflowRunId: data.workflowRunId,
            model: data.model,
            promptVersionId: data.promptVersionId ?? null,
            ...(data.pendingInputHash !== undefined
              ? { pendingInputHash: data.pendingInputHash }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(frameVariants.id, versionId),
              inArray(frameVariants.status, [...LIVE_PENDING_STATUSES])
            )
          )
          .returning();
        return row ?? null;
      } catch (error) {
        // Chained claims stamp snapshotInputHash at generation start. If another
        // live claim on this frame already holds that hash, the partial unique
        // index rejects the UPDATE. Stand down (null) like a cancel — do not
        // throw and burn workflow step retries.
        if (data.pendingInputHash != null && isUniqueConstraintError(error)) {
          return null;
        }
        throw error;
      }
    },

    /**
     * Status-guarded completion of an in-flight version (#1085 review): the
     * unguarded `update` let a completion racing a user cancel silently
     * resurrect the cancelled row to 'completed'. Returns null when the row
     * went terminal meanwhile — the caller must discard the render result
     * (the user was already told `cancelled: true`).
     */
    completeIfLive: async (
      versionId: string,
      data: Partial<NewFrameVariant>
    ): Promise<FrameVariant | null> => {
      const [row] = await db
        .update(frameVariants)
        .set({ ...data, status: 'completed', updatedAt: new Date() })
        .where(
          and(
            eq(frameVariants.id, versionId),
            inArray(frameVariants.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
      return row ?? null;
    },

    /** Terminal a live version row (cancel / zombie sweep); null when the row
     * was already terminal. */
    markTerminal: async (
      versionId: string,
      status: 'failed' | 'cancelled',
      error?: string
    ): Promise<FrameVariant | null> => {
      const [row] = await db
        .update(frameVariants)
        .set({ status, error: error ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(frameVariants.id, versionId),
            inArray(frameVariants.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
      return row ?? null;
    },

    /**
     * Cascade a failed/cancelled prompt-version row onto its dependent image
     * claims: a chained render whose upstream prompt died is 'cancelled' (it
     * was never attempted — distinct from 'failed'). Chain depth is 2 today,
     * so a single sweep is the whole walk.
     */
    cancelByDependency: async (
      promptVersionId: string,
      reason: string
    ): Promise<FrameVariant[]> => {
      return await db
        .update(frameVariants)
        .set({ status: 'cancelled', error: reason, updatedAt: new Date() })
        .where(
          and(
            eq(frameVariants.dependsOnVersionId, promptVersionId),
            inArray(frameVariants.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
    },

    /** Update generation tracking on an in-flight version (status/url/error/…). */
    update: async (
      versionId: string,
      data: Partial<NewFrameVariant>
    ): Promise<FrameVariant> => {
      const [version] = await db
        .update(frameVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frameVariants.id, versionId))
        .returning();
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      return version;
    },

    /**
     * The versions of one variant group, oldest-first so a per-model ordinal
     * label ("v1, v2, …") derives from position. Discarded rows are excluded
     * unless `includeDiscarded`.
     */
    listByGroup: async (
      group: VariantGroup,
      options?: { includeDiscarded?: boolean }
    ): Promise<FrameVariant[]> => {
      const conditions = [
        eq(frameVariants.frameId, group.frameId),
        eq(frameVariants.kind, group.kind),
        eq(frameVariants.model, group.model),
      ];
      // sourceVariantId distinguishes framing groups; match null explicitly so
      // model groups (null source) don't collide with framing picks.
      conditions.push(
        group.sourceVariantId == null
          ? isNull(frameVariants.sourceVariantId)
          : eq(frameVariants.sourceVariantId, group.sourceVariantId)
      );
      if (!options?.includeDiscarded) {
        conditions.push(isNull(frameVariants.discardedAt));
      }
      return await db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(...oldestFirst);
    },

    /**
     * All `kind:'model'` versions across a sequence, oldest-first (excludes
     * discarded). The image analog of the retired `shotVariants.listBySequence`
     * — the coverage UI reduces these to latest-per-(frameId, model). frameId
     * == the shot's id, so existing shot-keyed client logic keeps working.
     */
    listModelVersionsBySequence: async (
      sequenceId: string
    ): Promise<ImageVariantWithShot[]> => {
      // Join the owning frame to surface its `shotId` — the client keys image
      // coverage / per-shot filtering by shot, and frame ids ≠ shot ids (#989).
      const rows = await db
        .select({ variant: frameVariants, shotId: frames.shotId })
        .from(frameVariants)
        .innerJoin(frames, eq(frames.id, frameVariants.frameId))
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.kind, 'model'),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(...oldestFirst);
      return rows.map((r) => ({ ...r.variant, shotId: r.shotId }));
    },

    /**
     * Distinct `kind:'model'` model names ATTEMPTED in a sequence — in-flight,
     * failed, cancelled, or rendered — this drives the user-facing image-model
     * dropdown. Only the completed-without-image husk is excluded.
     *
     * Excluding the husk shape is load-bearing, not tidiness (#1133). Without
     * it the dropdown's correctness depends on the #1101 reclassify having
     * caught every `flux_2_turbo` row, and it did not: 58 rows across 15
     * sequences are still `kind:'model'` because a frame selects them, which
     * leaks the internal preview model in as a selectable option.
     *
     * The predicate is `NOT (completed AND no url)` rather than the blunter
     * `url IS NOT NULL`, which would also hide two kinds of row the user needs
     * to see: an in-flight render (pending/generating has no url yet, so a
     * model would vanish from the bar until its image landed) and a render
     * whose attempts all failed (hiding it hides the failure). `cancelled`
     * (#1085, never attempted) passes for the same reason as `failed`: a
     * terminal no-output state the user should see, not a husk. Measured against
     * production, the narrow form removes the same 15 leaking sequences while
     * losing 0 legitimate models; the blunt form also dropped 11.
     */
    listModelsForSequence: async (sequenceId: string): Promise<string[]> => {
      const rows = await db
        .selectDistinct({ model: frameVariants.model })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.kind, 'model'),
            // De Morgan of NOT (completed AND no url) — `status` is NOT NULL,
            // so the inequality is safe without a null guard.
            or(
              ne(frameVariants.status, 'completed'),
              isNotNull(frameVariants.url)
            ),
            isNull(frameVariants.discardedAt)
          )
        );
      return rows.map((r) => r.model);
    },

    /** All versions for a frame, oldest-first. Excludes discarded by default. */
    listByFrame: async (
      frameId: string,
      options?: { includeDiscarded?: boolean }
    ): Promise<FrameVariant[]> => {
      const conditions = [eq(frameVariants.frameId, frameId)];
      if (!options?.includeDiscarded) {
        conditions.push(isNull(frameVariants.discardedAt));
      }
      return await db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(...oldestFirst);
    },

    /**
     * The current 3×3 grid SHEET for a frame: the latest `kind:'framing'`
     * version with no `sourceVariantId` (the raw sheet — a chosen tile points
     * its `sourceVariantId` at the sheet it was cropped from). Drives the
     * picker's `variantImageUrl`. Returns null when no grid has been generated.
     */
    getLatestGridSheet: async (
      frameId: string
    ): Promise<FrameVariant | null> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.kind, 'framing'),
            isNull(frameVariants.sourceVariantId),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(...newestFirst)
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Batch of the latest grid sheet per frame across a sequence (for list
     * projection). Returns a Map keyed by frameId; frames with no grid are
     * absent. One query, reduced to newest-per-frame in app code.
     */
    listLatestGridSheetsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, FrameVariant>> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.kind, 'framing'),
            isNull(frameVariants.sourceVariantId),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(...oldestFirst);
      // asc by id (≈ time) → last write per frame wins.
      const byFrame = new Map<string, FrameVariant>();
      for (const row of rows) byFrame.set(row.frameId, row);
      return byFrame;
    },

    /**
     * The frame's current pre-prompt stand-in (#1101): the newest
     * non-discarded `kind: 'preview'` version. This IS the projection behind
     * `ShotView.previewThumbnailUrl` — what `frames.preview_image_url` used to
     * hold. Null when script analysis never produced one (or it was discarded).
     */
    getLatestPreview: async (frameId: string): Promise<FrameVariant | null> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.kind, 'preview'),
            // Matches the batch read — see getLatestPreviewByFrameIds.
            eq(frameVariants.status, 'completed'),
            isNotNull(frameVariants.url),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(...newestFirst)
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Batch {@link getLatestPreview}, keyed by frameId — frames with no preview
     * are absent, so `map.get(id) ?? null` matches the single-frame read.
     */
    listLatestPreviewsByFrameIds: (frameIds: string[]) =>
      getLatestPreviewByFrameIds(db, frameIds),

    /**
     * The model of each shot's SELECTED image version across a sequence, keyed
     * by the owning shot (#1066). Model identity lives on the version row that
     * produced the bytes, so this is what generate/display resolve from — see
     * `@/lib/ai/resolve-asset-models`. One join, so the batch read paths
     * (smart retry, the editor's model bar) don't go N+1. Shots whose anchor
     * frame has no selection are absent; the caller falls back a tier.
     *
     * Anchors only (`orderIndex 0`) — the same frame the shot's still surface
     * projects from — so a shot's later frames can't collide on the shot key.
     *
     * Discarded versions are excluded, matching every sibling read here: a
     * discarded version is hidden from the variant strip, so resolving from it
     * would show a model the user can no longer see.
     */
    listSelectedModelsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, string>> => {
      const rows = await db
        .select({ shotId: frames.shotId, model: frameVariants.model })
        .from(frames)
        .innerJoin(
          frameVariants,
          eq(frameVariants.id, frames.selectedImageVersionId)
        )
        .where(
          and(
            eq(frames.sequenceId, sequenceId),
            eq(frames.orderIndex, 0),
            isNull(frameVariants.discardedAt)
          )
        );
      return new Map(rows.map((r) => [r.shotId, r.model]));
    },

    /**
     * The `model` of each shot's newest FAILED image version, keyed by the
     * owning shot (#1066). A shot in a failed state is mid-attempt: this is the
     * model the user actually asked for, and it outranks the (older, still
     * selected) successful version when resolving a retry — otherwise a retry
     * silently re-runs the previous model. Anchors only, like the sibling above.
     */
    listLastFailedModelsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, string>> => {
      const rows = await db
        .select({
          shotId: frames.shotId,
          model: frameVariants.model,
          versionId: frameVariants.id,
        })
        .from(frames)
        .innerJoin(frameVariants, eq(frameVariants.frameId, frames.id))
        .where(
          and(
            eq(frames.sequenceId, sequenceId),
            eq(frames.orderIndex, 0),
            eq(frameVariants.kind, 'model'),
            eq(frameVariants.status, 'failed'),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(...oldestFirst);
      // asc by id (≈ time) → last write per shot wins.
      const byShot = new Map<string, string>();
      for (const row of rows) byShot.set(row.shotId, row.model);
      return byShot;
    },

    /**
     * The version the frame currently points at, or null if unset, dangling, or
     * discarded (see {@link listSelectedModelsBySequence} for why discarded is
     * excluded).
     */
    getSelected: async (frameId: string): Promise<FrameVariant | null> => {
      const [frame] = await db
        .select({ selected: frames.selectedImageVersionId })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame?.selected) return null;
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.id, frame.selected),
            isNull(frameVariants.discardedAt)
          )
        );
      return version ?? null;
    },

    /**
     * Batch {@link getSelected}, keyed by frameId. Same exclusions (no pointer,
     * dangling, discarded → absent), so `map.get(id) ?? null` matches it.
     */
    getSelectedByFrameIds: async (
      frameIds: string[]
    ): Promise<Map<string, FrameVariant>> => {
      if (frameIds.length === 0) return new Map();
      const byFrame = new Map<string, FrameVariant>();
      for (let i = 0; i < frameIds.length; i += PREVIEW_BY_FRAMES_BATCH) {
        const rows = await db
          .select({ frameId: frames.id, version: frameVariants })
          .from(frames)
          .innerJoin(
            frameVariants,
            eq(frameVariants.id, frames.selectedImageVersionId)
          )
          .where(
            and(
              inArray(
                frames.id,
                frameIds.slice(i, i + PREVIEW_BY_FRAMES_BATCH)
              ),
              isNull(frameVariants.discardedAt)
            )
          );
        for (const r of rows) byFrame.set(r.frameId, r.version);
      }
      return byFrame;
    },

    /**
     * The newest FAILED version for a frame, or null. The single-shot analog of
     * {@link listLastFailedModelsBySequence}.
     */
    getLastFailed: async (frameId: string): Promise<FrameVariant | null> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.kind, 'model'),
            eq(frameVariants.status, 'failed'),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(...newestFirst)
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Repoint the frame's selection at `versionId`: set
     * `frames.selectedImageVersionId`, mirror the version's image fields onto
     * the frame, and append an `image.selected` activity event — all in one
     * `db.batch()` so the pointer move and its event are atomic. The event's
     * `data` carries the previous pointer so the change is undoable.
     *
     * When the version carries a `promptVersionId` (#1070), also repoint
     * `frames.selectedImagePromptVersionId` and mirror that prompt's text/hash
     * so the still and the prompt that produced it stay paired. Missing /
     * cross-frame prompt rows are skipped (legacy gens have null). Returns the
     * selected image version.
     */
    select: async (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<FrameVariant> => {
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.id, versionId),
            eq(frameVariants.frameId, frameId)
          )
        );
      if (!version) {
        throw new Error(
          `FrameVariant ${versionId} not found for frame ${frameId}`
        );
      }
      // A preview renders the raw scene text, not the frame's prompt (#1101),
      // so promoting one would pair the still with a prompt it was never
      // rendered from — and its url expires. Reject at the one door every
      // selection goes through, so `frames.selectedImageVersionId` (and every
      // render manifest that snapshots it) can never name a preview.
      const { kind } = version;
      if (!isSelectableFrameVariantKind(kind)) {
        throw new Error(
          `FrameVariant ${versionId} is kind '${kind}' — a preview is a pre-prompt stand-in and can never become a frame's still`
        );
      }
      // Only a finished image may become the frame's primary still. Selecting a
      // pending/failed version would mirror its null url + failed status onto
      // the frame, silently blanking a good image.
      if (version.status !== 'completed') {
        throw new Error(
          `FrameVariant ${versionId} is '${version.status}', not 'completed' — cannot select an unfinished image`
        );
      }
      // `version` is a single object type, so the guards above narrow reads of
      // its fields but not `version` as a whole — re-affirm both in a typed
      // local so the mirror builder's precondition is met without an unsafe
      // assertion.
      const promotableVersion: PromotableFrameVariant = {
        ...version,
        kind,
        status: 'completed',
      };
      const mirrorUpdate = buildFrameImageSelection(
        db,
        frameId,
        promotableVersion
      );

      const [frame] = await db
        .select({
          sequenceId: frames.sequenceId,
          prev: frames.selectedImageVersionId,
          prevPromptVersionId: frames.selectedImagePromptVersionId,
          pendingPromoteVersionId: frames.pendingPromoteVersionId,
        })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) {
        throw new Error(`Frame ${frameId} not found`);
      }

      // Cancel auto-promote only when the user picks a *different* version than
      // the current primary (#1070). Re-selecting the current still leaves
      // pending intact. Completing a gen that selects its pending version also
      // hits prev !== versionId and clears pending (promote consumed).
      const shouldClearPending =
        frame.prev !== versionId && frame.pendingPromoteVersionId != null;

      // Resolve the prompt that was live when this still was generated, if any.
      // Soft pointer — the row may have been pruned or never recorded.
      let linkedPrompt: {
        id: string;
        text: string;
        inputHash: string | null;
      } | null = null;
      if (version.promptVersionId) {
        const [promptRow] = await db
          .select({
            id: framePromptVersions.id,
            text: framePromptVersions.text,
            inputHash: framePromptVersions.inputHash,
            frameId: framePromptVersions.frameId,
            status: framePromptVersions.status,
          })
          .from(framePromptVersions)
          .where(eq(framePromptVersions.id, version.promptVersionId));
        // A non-completed row is a placeholder — mirroring it would blank the
        // frame's prompt with empty text (#1085).
        if (
          promptRow &&
          promptRow.frameId === frameId &&
          promptRow.status === 'completed'
        ) {
          linkedPrompt = promptRow;
        }
      }

      const imageSelectedEvent = buildEventInsert(db, {
        sequenceId: frame.sequenceId,
        actorId: opts.actorId,
        kind: 'image.selected',
        targetType: 'frame',
        targetId: frameId,
        summary: `Selected ${version.model} image`,
        data: {
          versionId,
          model: version.model,
          prevVersionId: frame.prev ?? null,
          promptVersionId: linkedPrompt?.id ?? null,
          prevPromptVersionId: frame.prevPromptVersionId ?? null,
        },
      });

      // Repointing the prompt is an explicit user choice (#1085): revoke the
      // mirror rights of any in-flight prompt claims on this frame so a
      // completing regeneration lands in history without clobbering it.
      const demotePromptClaims = () =>
        db
          .update(framePromptVersions)
          .set({ pendingInputHash: null })
          .where(
            and(
              eq(framePromptVersions.frameId, frameId),
              inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
            )
          );

      if (linkedPrompt && shouldClearPending) {
        await db.batch([
          mirrorUpdate,
          imageSelectedEvent,
          demotePromptClaims(),
          db
            .update(frames)
            .set({
              selectedImagePromptVersionId: linkedPrompt.id,
              pendingPromoteVersionId: null,
              updatedAt: new Date(),
            })
            .where(eq(frames.id, frameId)),
          buildEventInsert(db, {
            sequenceId: frame.sequenceId,
            actorId: opts.actorId,
            kind: 'prompt.selected',
            targetType: 'frame',
            targetId: frameId,
            summary: 'Restored image prompt with selected still',
            data: {
              versionId: linkedPrompt.id,
              prevVersionId: frame.prevPromptVersionId ?? null,
              fromImageVersionId: versionId,
            },
          }),
        ]);
      } else if (linkedPrompt) {
        await db.batch([
          mirrorUpdate,
          imageSelectedEvent,
          demotePromptClaims(),
          db
            .update(frames)
            .set({
              selectedImagePromptVersionId: linkedPrompt.id,
              updatedAt: new Date(),
            })
            .where(eq(frames.id, frameId)),
          buildEventInsert(db, {
            sequenceId: frame.sequenceId,
            actorId: opts.actorId,
            kind: 'prompt.selected',
            targetType: 'frame',
            targetId: frameId,
            summary: 'Restored image prompt with selected still',
            data: {
              versionId: linkedPrompt.id,
              prevVersionId: frame.prevPromptVersionId ?? null,
              fromImageVersionId: versionId,
            },
          }),
        ]);
      } else if (shouldClearPending) {
        await db.batch([
          mirrorUpdate,
          imageSelectedEvent,
          db
            .update(frames)
            .set({
              pendingPromoteVersionId: null,
              updatedAt: new Date(),
            })
            .where(eq(frames.id, frameId)),
        ]);
      } else {
        await db.batch([mirrorUpdate, imageSelectedEvent]);
      }
      return version;
    },

    /**
     * Select `versionId` only while the frame's auto-promote claim still points
     * at it (#1070). The predicate rides in the claim-consuming UPDATE's WHERE,
     * so a concurrent kickoff or explicit history select that moved the pointer
     * between a read and the select can no longer be overwritten. Returns null
     * when the claim had already moved — the caller finalizes into history.
     */
    selectIfPendingPromoteIs: async (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<FrameVariant | null> => {
      const claimed = await db
        .update(frames)
        .set({ pendingPromoteVersionId: null, updatedAt: new Date() })
        .where(
          and(
            eq(frames.id, frameId),
            eq(frames.pendingPromoteVersionId, versionId)
          )
        )
        .returning({ id: frames.id });
      if (claimed.length === 0) return null;
      return await methods.select(frameId, versionId, opts);
    },

    /**
     * Soft-hide a version (undoable). Commits the `discardedAt` write and an
     * `image.discarded` event in one batch. Returns the timestamp for an Undo.
     */
    discard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [version] = await db
        .select({
          sequenceId: frameVariants.sequenceId,
          frameId: frameVariants.frameId,
        })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const discardedAt = new Date();
      await db.batch([
        db
          .update(frameVariants)
          .set({ discardedAt, updatedAt: discardedAt })
          .where(eq(frameVariants.id, versionId)),
        // Drop auto-promote claim if it pointed at this version (#1070).
        db
          .update(frames)
          .set({ pendingPromoteVersionId: null, updatedAt: discardedAt })
          .where(
            and(
              eq(frames.id, version.frameId),
              eq(frames.pendingPromoteVersionId, versionId)
            )
          ),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'image.discarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
      return discardedAt;
    },

    /** Undo a discard (clears `discardedAt`), with a matching event. */
    undiscard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<void> => {
      const [version] = await db
        .select({ sequenceId: frameVariants.sequenceId })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const now = new Date();
      await db.batch([
        db
          .update(frameVariants)
          .set({ discardedAt: null, updatedAt: now })
          .where(eq(frameVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'image.undiscarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
    },

    /**
     * Staleness of a single version: stored `inputHash` vs a fresh hash. Null
     * stored hash (legacy / in-flight) is "unknown, not stale". Throws when the
     * version is missing. Mirrors `shotVariants.isStale`.
     */
    isStale: async (
      versionId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: frameVariants.inputHash })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      const row = result[0];
      if (!row) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    deleteByFrame: async (frameId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.frameId, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },
  };
  return methods;
}
