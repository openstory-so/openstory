/**
 * Scoped Frames Sub-module
 *
 * A frame is the IMAGE unit — one still keyframe within a shot (1 frame = 1
 * image). A shot owns 1..N frames (role first|last|key). The frame's primary
 * still is a cached MIRROR of whichever `frame_variants` version
 * `frames.selectedImageVersionId` points at; the model alternates live in
 * `frame_variants` and the visual-prompt history in `frame_prompt_versions`.
 *
 * The mirror columns (`imageUrl`, `imagePath`, …) are written here via
 * {@link buildFrameImageMirror} so the "which columns mirror a selected
 * version" knowledge lives with the frame; `frame_variants.select` composes
 * that statement into its repoint batch.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/lib/db/client';
import { frameVariants, frames } from '@/lib/db/schema';
import type { Frame, FrameVariant, NewFrame } from '@/lib/db/schema';
import {
  type SelectableFrameVariantKind,
  isSelectableFrameVariantKind,
} from '@/lib/db/schema/frame-variants';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

/** A frame plus the `frame_variants` version it currently points at (if any). */
export type ResolvedFrame = {
  frame: Frame;
  selectedVersion: FrameVariant | null;
};

/**
 * A frame variant that has finished generating — mirroring a pending/failed
 * version would copy its null url + non-completed status onto the frame,
 * silently blanking a good image.
 */
type CompletedFrameVariant = FrameVariant & { status: 'completed' };

/**
 * The ONLY shape that may become a frame's primary still: finished AND of a
 * selectable kind. Both halves are needed — `recordPreview` writes previews as
 * `status: 'completed'`, so completeness alone would admit one (#1101), and a
 * preview renders the raw scene text rather than the frame's prompt.
 *
 * Encoding both preconditions in {@link buildFrameImageSelection}'s signature
 * keeps them compile-time enforced rather than relying on runtime guards living
 * in the (sibling-module) caller.
 */
export type PromotableFrameVariant = CompletedFrameVariant & {
  kind: SelectableFrameVariantKind;
};

/**
 * UPDATE repointing a frame's image selection, unexecuted so the caller can
 * batch it with the activity event. {@link PromotableFrameVariant} is required
 * so neither an unfinished image nor a preview can become the frame's still.
 */
export function buildFrameImageSelection(
  db: Database,
  frameId: string,
  version: PromotableFrameVariant
) {
  return db
    .update(frames)
    .set({
      selectedImageVersionId: version.id,
      imageStatus: version.status,
      imageError: version.error,
      updatedAt: new Date(),
    })
    .where(eq(frames.id, frameId));
}

type FrameOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

/**
 * Selection-owned columns, excluded from generic `update` so a partial write
 * can't move a pointer on its own. Move selections via `frameVariants.select`
 * or `framePromptVersions.write`/`select`.
 */
type FrameMirrorColumn =
  | 'selectedImageVersionId'
  | 'imageStatus'
  | 'imageError'
  | 'selectedImagePromptVersionId';

/** Fields `update` accepts — everything on a frame except the mirror columns. */
export type FrameUpdateInput = Omit<Partial<NewFrame>, FrameMirrorColumn>;

// One bound param per id; 90 keeps each query under D1's 100-bound-parameter
// ceiling (#1322). Unit tests run on libsql, which has no such cap — an
// unchunked list passes CI and throws `too many SQL variables` on D1.
const FRAMES_BY_IDS_BATCH = 90;

export function createFramesMethods(db: Database) {
  return {
    getById: async (frameId: string): Promise<Frame | null> => {
      const result = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frameId));
      return result[0] ?? null;
    },

    getByIds: async (frameIds: string[]): Promise<Frame[]> => {
      if (frameIds.length === 0) return [];
      const rows: Frame[] = [];
      for (let i = 0; i < frameIds.length; i += FRAMES_BY_IDS_BATCH) {
        rows.push(
          ...(await db
            .select()
            .from(frames)
            .where(
              inArray(frames.id, frameIds.slice(i, i + FRAMES_BY_IDS_BATCH))
            ))
        );
      }
      return rows;
    },

    /**
     * The shot's anchor frame — its first frame (role 'first', orderIndex 0):
     * the i2v anchor and the shot's primary still. Resolved BY SHOT, never by
     * id-reuse. The migration backfilled anchors with `frame.id = shot.id`, but
     * that equality is a one-time migration artifact and must NOT be assumed at
     * runtime — newly created frames get their own id (#989). Returns null when
     * the shot has no frame yet (callers handle absence).
     */
    getAnchorByShot: async (shotId: string): Promise<Frame | null> => {
      const result = await db
        .select()
        .from(frames)
        .where(and(eq(frames.shotId, shotId), eq(frames.orderIndex, 0)));
      return result[0] ?? null;
    },

    /**
     * Anchor frame (orderIndex 0) for each given shot, keyed by `shotId`. One
     * row per shot via the `(shotId, orderIndex)` unique index; shots without a
     * frame are absent from the map.
     */
    getAnchorsByShots: async (
      shotIds: string[]
    ): Promise<Map<string, Frame>> => {
      if (shotIds.length === 0) return new Map();
      const rows = await db
        .select()
        .from(frames)
        .where(and(inArray(frames.shotId, shotIds), eq(frames.orderIndex, 0)));
      return new Map(rows.map((f) => [f.shotId, f]));
    },

    /** Anchor frame (orderIndex 0) of every shot in a sequence. */
    listAnchorsBySequence: async (sequenceId: string): Promise<Frame[]> => {
      return await db
        .select()
        .from(frames)
        .where(
          and(eq(frames.sequenceId, sequenceId), eq(frames.orderIndex, 0))
        );
    },

    /** Frames of a shot, ordered (0 = first/anchor by default). */
    listByShot: async (shotId: string): Promise<Frame[]> => {
      return await db
        .select()
        .from(frames)
        .where(eq(frames.shotId, shotId))
        .orderBy(asc(frames.orderIndex));
    },

    listBySequence: async (
      sequenceId: string,
      options?: { orderBy?: FrameOrderBy; ascending?: boolean }
    ): Promise<Frame[]> => {
      const { orderBy = 'createdAt', ascending = true } = options ?? {};
      const orderColumn =
        orderBy === 'orderIndex'
          ? frames.orderIndex
          : orderBy === 'updatedAt'
            ? frames.updatedAt
            : frames.createdAt;
      const orderFn = ascending ? asc : desc;
      return await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId))
        .orderBy(orderFn(orderColumn));
    },

    create: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db.insert(frames).values(data).returning();
      if (!frame) {
        throw new Error(`Failed to create frame for shot ${data.shotId}`);
      }
      return frame;
    },

    /**
     * Idempotent insert keyed on the `(shot_id, order_index)` unique index —
     * a replay re-deriving the same frame slot updates in place rather than
     * colliding. The `role` identity column and the image mirror are left to
     * dedicated paths.
     */
    upsert: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db
        .insert(frames)
        .values(data)
        .onConflictDoUpdate({
          target: [frames.shotId, frames.orderIndex],
          set: { role: data.role, updatedAt: new Date() },
        })
        .returning();
      if (!frame) {
        throw new Error(
          `Failed to upsert frame for shot ${data.shotId} at orderIndex ${data.orderIndex}`
        );
      }
      return frame;
    },

    /**
     * Update non-mirror frame fields. Selection pointers and their mirrored
     * image / prompt columns are intentionally excluded (see
     * {@link FrameUpdateInput}); move a selection via `frameVariants.select` or
     * `framePromptVersions.write`/`select` instead.
     */
    update: async (
      frameId: string,
      data: FrameUpdateInput,
      options?: { throwOnMissing?: boolean }
    ): Promise<Frame | undefined> => {
      const [frame] = await db
        .update(frames)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frames.id, frameId))
        .returning();
      if (!frame && options?.throwOnMissing !== false) {
        throw new Error(`Frame ${frameId} not found`);
      }
      return frame;
    },

    /** The primary render's in-flight lifecycle. No `frame_variants` row records it. */
    setImageGenerationStatus: async (
      frameId: string,
      data: Pick<
        Partial<NewFrame>,
        'imageStatus' | 'imageWorkflowRunId' | 'imageError'
      >,
      options?: { throwOnMissing?: boolean }
    ): Promise<Frame | undefined> => {
      const [frame] = await db
        .update(frames)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frames.id, frameId))
        .returning();
      if (!frame && options?.throwOnMissing !== false) {
        throw new Error(`Frame ${frameId} not found`);
      }
      return frame;
    },

    /**
     * Claim auto-promote for a primary image gen (#1070). Last kickoff wins —
     * overwrites any prior pending id. Pass `null` to cancel (explicit select /
     * failure). Soft pointer; no FK.
     */
    setPendingPromoteVersionId: async (
      frameId: string,
      versionId: string | null
    ): Promise<void> => {
      // A preview is a pre-prompt stand-in and can never become a still
      // (#1101). `frameVariants.select` already refuses one, but promotion is
      // an unattended path — a claim pointed here would surface as a workflow
      // failure minutes later instead of at the mistake. Same allowlist
      // spelling as `select`, so a future non-selectable kind is refused by
      // both doors rather than slipping past this one.
      if (versionId !== null) {
        const [target] = await db
          .select({ kind: frameVariants.kind })
          .from(frameVariants)
          .where(eq(frameVariants.id, versionId));
        if (!target) {
          throw new Error(
            `FrameVariant ${versionId} does not exist — refusing to leave frame ${frameId} with a dangling promote claim`
          );
        }
        if (!isSelectableFrameVariantKind(target.kind)) {
          throw new Error(
            `FrameVariant ${versionId} is kind '${target.kind}' — it can never be promoted to frame ${frameId}'s still`
          );
        }
      }
      await db
        .update(frames)
        .set({ pendingPromoteVersionId: versionId, updatedAt: new Date() })
        .where(eq(frames.id, frameId));
    },

    /**
     * Clear pending only when it still points at `versionId` — so a newer
     * kickoff's claim is not wiped by an older job's failure/complete path.
     */
    clearPendingPromoteVersionIdIf: async (
      frameId: string,
      versionId: string
    ): Promise<void> => {
      await db
        .update(frames)
        .set({ pendingPromoteVersionId: null, updatedAt: new Date() })
        .where(
          and(
            eq(frames.id, frameId),
            eq(frames.pendingPromoteVersionId, versionId)
          )
        );
    },

    delete: async (frameId: string): Promise<boolean> => {
      const result = await db.delete(frames).where(eq(frames.id, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteByShot: async (shotId: string): Promise<number> => {
      const result = await db.delete(frames).where(eq(frames.shotId, shotId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frames)
        .where(eq(frames.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /** The frame plus its selected version — the only source of the still. */
    resolveCurrent: async (frameId: string): Promise<ResolvedFrame | null> => {
      const [frame] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) return null;
      if (!frame.selectedImageVersionId) {
        return { frame, selectedVersion: null };
      }
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, frame.selectedImageVersionId));
      return { frame, selectedVersion: version ?? null };
    },

    /**
     * Selected version's `inputHash` vs a fresh hash. Null stored hash (no
     * selection, or never generated) is "unknown, not stale" — never forces
     * regeneration. Throws when the frame is missing.
     */
    isStale: async (frameId: string, currentHash: string): Promise<boolean> => {
      const result = await db
        .select({
          frameId: frames.id,
          hash: frameVariants.inputHash,
        })
        .from(frames)
        .leftJoin(
          frameVariants,
          eq(frameVariants.id, frames.selectedImageVersionId)
        )
        .where(eq(frames.id, frameId));
      const row = result[0];
      if (!row) {
        throw new Error(`Frame ${frameId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },
  };
}
