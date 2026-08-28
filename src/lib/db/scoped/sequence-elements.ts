/**
 * Scoped Sequence Elements Sub-module
 * Element CRUD for per-sequence uploaded reference images.
 */

import type { Database } from '@/lib/db/client';
import type {
  ElementVisionStatus,
  Shot,
  NewSequenceElement,
  SequenceElement,
} from '@/lib/db/schema';
import {
  framePromptVersions,
  frames,
  renderSegments,
  scenes,
  sceneScriptVersions,
  shots,
  shotPromptVersions,
  sequenceElements,
  sequences,
  videoVariants,
} from '@/lib/db/schema';
import {
  buildShotRenameDeltas,
  replaceTokenInText,
  renameTokenInContinuity,
} from '@/lib/sequence-elements/cascade-rename';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { matchElementsToShotImage } from '@/lib/workflows/scene-matching';
import { and, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { buildEventInsert } from './sequence-events';

/** Selected visual prompt text for each shot's anchor frame, keyed by shot id. */
async function loadVisualPromptsByShotId(
  db: Database,
  sequenceId: string
): Promise<Map<string, string>> {
  const rows = await db
    .select({ shotId: frames.shotId, text: framePromptVersions.text })
    .from(frames)
    .innerJoin(
      framePromptVersions,
      eq(frames.selectedImagePromptVersionId, framePromptVersions.id)
    )
    .where(and(eq(frames.sequenceId, sequenceId), eq(frames.orderIndex, 0)));
  return new Map(rows.map((r) => [r.shotId, r.text]));
}

export function createSequenceElementsMethods(db: Database) {
  const update = async (
    id: string,
    data: Partial<NewSequenceElement>
  ): Promise<SequenceElement> => {
    const [element] = await db
      .update(sequenceElements)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sequenceElements.id, id))
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB may return undefined
    if (!element) {
      throw new Error(`SequenceElement ${id} not found`);
    }

    return element;
  };

  const getById = async (id: string): Promise<SequenceElement | null> => {
    const result = await db
      .select()
      .from(sequenceElements)
      .where(eq(sequenceElements.id, id));
    return result[0] ?? null;
  };

  const getByToken = async (
    sequenceId: string,
    token: string
  ): Promise<SequenceElement | null> => {
    const result = await db
      .select()
      .from(sequenceElements)
      .where(
        and(
          eq(sequenceElements.sequenceId, sequenceId),
          eq(sequenceElements.token, token)
        )
      );
    return result[0] ?? null;
  };

  return {
    getById,

    getByToken,

    /**
     * Throws if `token` is already taken by another element in this sequence.
     * Use for user-driven renames where collisions must be surfaced; for
     * system-driven renames (vision auto-suggest), use ensureUniqueToken
     * which suffixes a `_N` instead.
     */
    isTokenTaken: async (
      sequenceId: string,
      token: string,
      excludeElementId?: string
    ): Promise<boolean> => {
      const whereClauses = [
        eq(sequenceElements.sequenceId, sequenceId),
        eq(sequenceElements.token, token),
      ];
      if (excludeElementId) {
        whereClauses.push(ne(sequenceElements.id, excludeElementId));
      }
      const rows = await db
        .select({ id: sequenceElements.id })
        .from(sequenceElements)
        .where(and(...whereClauses));
      return rows.length > 0;
    },

    /**
     * Pass `excludeElementId` when the token is being assigned to an existing
     * element (e.g. the vision auto-rename) — otherwise the element's own row
     * counts as a collision and a workflow-step retry after a successful
     * rename suffixes the token to `TOKEN_2`.
     */
    ensureUniqueToken: async (
      sequenceId: string,
      token: string,
      excludeElementId?: string
    ): Promise<string> => {
      // Escape LIKE wildcards (%, _, \) so `foo_bar` doesn't match `foo1bar`.
      const escaped = token.replace(/[\\%_]/g, (c) => `\\${c}`);
      const whereClauses = [
        eq(sequenceElements.sequenceId, sequenceId),
        or(
          eq(sequenceElements.token, token),
          like(sequenceElements.token, sql`${`${escaped}\\_%`} ESCAPE '\\'`)
        ),
      ];
      if (excludeElementId) {
        whereClauses.push(ne(sequenceElements.id, excludeElementId));
      }
      const rows = await db
        .select({ token: sequenceElements.token })
        .from(sequenceElements)
        .where(and(...whereClauses));

      const taken = new Set(rows.map((r) => r.token));
      if (!taken.has(token)) return token;

      // Hard cap — 100 is well above any realistic upload-of-same-name count
      // and bounds the worst-case query path.
      for (let suffix = 2; suffix <= 100; suffix += 1) {
        const candidate = `${token}_${suffix}`;
        if (!taken.has(candidate)) return candidate;
      }
      throw new Error('Unable to generate unique element token');
    },

    // Default list excludes soft-deleted rows (#1108): a deleted element must
    // vanish from the elements grid and the prompt-context element bible.
    // Token uniqueness (isTokenTaken / ensureUniqueToken) deliberately still
    // counts deleted rows so a restore can never collide.
    list: async (sequenceId: string): Promise<SequenceElement[]> => {
      return await db
        .select()
        .from(sequenceElements)
        .where(
          and(
            eq(sequenceElements.sequenceId, sequenceId),
            isNull(sequenceElements.deletedAt)
          )
        )
        .orderBy(sequenceElements.createdAt);
    },

    listByIds: async (ids: string[]): Promise<SequenceElement[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(sequenceElements)
        .where(inArray(sequenceElements.id, ids));
    },

    create: async (data: NewSequenceElement): Promise<SequenceElement> => {
      const [element] = await db
        .insert(sequenceElements)
        .values(data)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB may return undefined
      if (!element) {
        throw new Error('Failed to insert sequence element');
      }
      return element;
    },

    update,

    updateVisionStatus: async (
      id: string,
      status: ElementVisionStatus,
      error?: string
    ): Promise<SequenceElement> => {
      return await update(id, {
        visionStatus: status,
        visionError: error ?? null,
        ...(status === 'completed' && { visionGeneratedAt: new Date() }),
      });
    },

    updateVisionResult: async (
      id: string,
      description: string,
      consistencyTag: string
    ): Promise<SequenceElement> => {
      return await update(id, {
        description,
        consistencyTag,
        visionStatus: 'completed',
        visionGeneratedAt: new Date(),
        visionError: null,
      });
    },

    updateFirstMention: async (
      id: string,
      firstMention: {
        sceneId: string;
        text: string;
        lineNumber: number;
      }
    ): Promise<SequenceElement> => {
      return await update(id, {
        firstMentionSceneId: firstMention.sceneId,
        firstMentionText: firstMention.text,
        firstMentionLine: firstMention.lineNumber,
      });
    },

    /**
     * Rename an element's token and rewrite every reference to the old token
     * across the sequence: `sequences.script`, `scenes.continuity` +
     * the selected `scene_script_versions` extract, the anchor frame's
     * `imagePrompt` and the selected `shot_prompt_versions` motion text.
     *
     * All writes (element row, script, shot deltas) run in a single
     * `db.batch()` — one transaction — so a mid-cascade failure can't leave
     * mixed token references (and a workflow-step retry then renaming the
     * remainder to `TOKEN_2`, splitting element/script/frames).
     *
     * Returns the affected counts so callers can surface a meaningful toast
     * ("Renamed LOGO → BRAND across 5 shots + script"). The caller is
     * expected to have already validated uniqueness of `newToken` within the
     * sequence — this method does not check collisions.
     *
     * `expectedToken` turns the rename into a compare-and-swap for
     * system-driven renames (the vision auto-rename): the element row is only
     * updated `WHERE token = expectedToken`, and the cascade is skipped
     * entirely when the row no longer carries it. Callers get `renamed: false`
     * plus the live row, so a user rename that landed mid-flight wins and the
     * script is never rewritten against a token the user renamed away from.
     */
    cascadeRename: async (args: {
      sequenceId: string;
      elementId: string;
      oldToken: string;
      newToken: string;
      expectedToken?: string;
    }): Promise<{
      element: SequenceElement;
      shotsUpdated: number;
      scriptUpdated: boolean;
      renamed: boolean;
    }> => {
      const { sequenceId, elementId, oldToken, newToken, expectedToken } = args;

      if (expectedToken !== undefined) {
        const current = await getById(elementId);
        if (!current) {
          throw new Error(`SequenceElement ${elementId} not found`);
        }
        if (current.token !== expectedToken) {
          return {
            element: current,
            shotsUpdated: 0,
            scriptUpdated: false,
            renamed: false,
          };
        }
      }

      if (oldToken === newToken) {
        const element = await update(elementId, { token: newToken });
        return {
          element,
          shotsUpdated: 0,
          scriptUpdated: false,
          renamed: true,
        };
      }

      const now = new Date();
      const elementUpdate = db
        .update(sequenceElements)
        .set({ token: newToken, updatedAt: now })
        .where(
          expectedToken === undefined
            ? eq(sequenceElements.id, elementId)
            : and(
                eq(sequenceElements.id, elementId),
                eq(sequenceElements.token, expectedToken)
              )
        )
        .returning();

      const [sequenceRow] = await db
        .select({ script: sequences.script })
        .from(sequences)
        .where(eq(sequences.id, sequenceId));
      let rewrittenScript: string | null = null;
      if (sequenceRow?.script) {
        const rewritten = replaceTokenInText(
          sequenceRow.script,
          oldToken,
          newToken
        );
        if (rewritten !== sequenceRow.script) {
          rewrittenScript = rewritten;
        }
      }
      const scriptUpdated = rewrittenScript !== null;
      const scriptStatements =
        rewrittenScript === null
          ? []
          : [
              db
                .update(sequences)
                .set({ script: rewrittenScript, updatedAt: now })
                .where(eq(sequences.id, sequenceId)),
            ];

      const allShots = (await db
        .select()
        .from(shots)
        .where(eq(shots.sequenceId, sequenceId))) as Shot[];
      // The image prompt lives on each shot's anchor frame now (#989) — keyed
      // by shotId (orderIndex 0), never by id-reuse.
      const frameRows = await db
        .select({
          id: frames.id,
          shotId: frames.shotId,
          imagePrompt: framePromptVersions.text,
          promptVersionId: framePromptVersions.id,
        })
        .from(frames)
        .leftJoin(
          framePromptVersions,
          eq(framePromptVersions.id, frames.selectedImagePromptVersionId)
        )
        .where(
          and(eq(frames.sequenceId, sequenceId), eq(frames.orderIndex, 0))
        );
      const imagePromptByShot = new Map(
        frameRows.map((f) => [f.shotId, f.imagePrompt])
      );
      const promptVersionIdByShot = new Map(
        frameRows.flatMap((f) =>
          f.promptVersionId ? [[f.shotId, f.promptVersionId]] : []
        )
      );
      // The motion prompt is the *selected* `shot_prompt_versions` row (#713):
      // both the token scan and the rewrite target that row.
      const selectedMotionRows = await db
        .select({
          shotId: shots.id,
          versionId: shotPromptVersions.id,
          text: shotPromptVersions.text,
        })
        .from(shots)
        .innerJoin(
          shotPromptVersions,
          eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
        )
        .where(eq(shots.sequenceId, sequenceId));
      const motionPromptByShot = new Map(
        selectedMotionRows.map((r) => [r.shotId, r.text])
      );
      const selectedMotionVersionByShot = new Map(
        selectedMotionRows.map((r) => [r.shotId, r.versionId])
      );
      const shotsWithPrompts = allShots.map((s) => ({
        ...s,
        imagePrompt: imagePromptByShot.get(s.id) ?? null,
        motionPrompt: motionPromptByShot.get(s.id) ?? null,
      }));
      const deltas = buildShotRenameDeltas(
        shotsWithPrompts,
        oldToken,
        newToken
      );
      const selectedScriptRows = await db
        .select({ version: sceneScriptVersions })
        .from(scenes)
        .innerJoin(
          sceneScriptVersions,
          eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
        )
        .where(eq(scenes.sequenceId, sequenceId));
      // Element tags live on the scene's continuity now, so the token rewrite
      // targets `scenes.continuity` rather than a per-shot copy.
      const sceneRows = await db
        .select()
        .from(scenes)
        .where(eq(scenes.sequenceId, sequenceId));
      const sceneContinuityStatements = sceneRows.flatMap((scene) => {
        if (!scene.continuity) return [];
        const rewritten = renameTokenInContinuity(
          scene.continuity,
          oldToken,
          newToken
        );
        if (!rewritten) return [];
        return [
          db
            .update(scenes)
            .set({ continuity: rewritten, updatedAt: now })
            .where(eq(scenes.id, scene.id)),
        ];
      });

      const sceneScriptStatements = selectedScriptRows.flatMap(
        ({ version }) => {
          const extract = version.content.extract;
          if (!extract) return [];
          const rewritten = replaceTokenInText(extract, oldToken, newToken);
          if (rewritten === extract) return [];
          return [
            db
              .update(sceneScriptVersions)
              .set({
                content: { ...version.content, extract: rewritten },
              })
              .where(eq(sceneScriptVersions.id, version.id)),
          ];
        }
      );

      const shotStatements = deltas.flatMap((delta) => {
        const selectedMotionVersionId = selectedMotionVersionByShot.get(
          delta.shotId
        );
        const selectedPromptVersionId = promptVersionIdByShot.get(delta.shotId);
        return [
          ...(delta.motionPrompt !== undefined && selectedMotionVersionId
            ? [
                db
                  .update(shotPromptVersions)
                  .set({ text: delta.motionPrompt })
                  .where(eq(shotPromptVersions.id, selectedMotionVersionId)),
              ]
            : []),
          ...(delta.imagePrompt !== undefined && selectedPromptVersionId
            ? [
                db
                  .update(framePromptVersions)
                  .set({ text: delta.imagePrompt })
                  .where(eq(framePromptVersions.id, selectedPromptVersionId)),
              ]
            : []),
        ];
      });

      const [elementRows] = await db.batch([
        elementUpdate,
        ...scriptStatements,
        ...sceneContinuityStatements,
        ...sceneScriptStatements,
        ...shotStatements,
      ]);
      const element = elementRows[0];
      if (!element) {
        // Only reachable under `expectedToken` — a rename that landed between
        // the pre-check above and this batch. D1 has no interactive
        // transactions, so that microsecond window is the residual: report the
        // swap as lost and let the caller keep the live row.
        if (expectedToken !== undefined) {
          const current = await getById(elementId);
          if (!current) {
            throw new Error(`SequenceElement ${elementId} not found`);
          }
          return {
            element: current,
            shotsUpdated: deltas.length,
            scriptUpdated,
            renamed: false,
          };
        }
        throw new Error(`SequenceElement ${elementId} not found`);
      }

      return {
        element,
        shotsUpdated: deltas.length,
        scriptUpdated,
        renamed: true,
      };
    },

    /**
     * Soft-hide an element (undoable, #1108): stamp `deletedAt` + an
     * `element.deleted` event in one batch. The product Delete button routes
     * here; {@link delete} (hard) remains for admin/GC only. Returns the
     * timestamp for the toast Undo; idempotent.
     */
    softDelete: async (
      id: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [existing] = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, id));
      if (!existing) {
        throw new Error(`SequenceElement ${id} not found`);
      }
      if (existing.deletedAt) return existing.deletedAt;
      const deletedAt = new Date();
      await db.batch([
        db
          .update(sequenceElements)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(eq(sequenceElements.id, id)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'element.deleted',
          targetType: 'element',
          targetId: id,
          summary: `Removed element ${existing.token}`,
          data: { token: existing.token },
        }),
      ]);
      return deletedAt;
    },

    /** Undo an element soft delete, with a matching event. */
    restore: async (
      id: string,
      opts: { actorId: string | null }
    ): Promise<SequenceElement> => {
      const [existing] = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, id));
      if (!existing) {
        throw new Error(`SequenceElement ${id} not found`);
      }
      const now = new Date();
      const [restoredRows] = await db.batch([
        db
          .update(sequenceElements)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(sequenceElements.id, id))
          .returning(),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'element.restored',
          targetType: 'element',
          targetId: id,
          summary: `Restored element ${existing.token}`,
          data: { token: existing.token },
        }),
      ]);
      const restored = restoredRows[0];
      if (!restored) {
        throw new Error(`SequenceElement ${id} disappeared during restore`);
      }
      return restored;
    },

    /** HARD delete — admin/GC only; the product Delete is {@link softDelete}. */
    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(sequenceElements)
        .where(eq(sequenceElements.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined
      return (result.rowsAffected ?? 0) > 0;
    },

    getShotIdsForElement: async (
      sequenceId: string,
      elementId: string
    ): Promise<string[]> => {
      const elementResult = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, elementId));
      const element = elementResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!element || element.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext, promptByShotId] = await Promise.all([
        // Live shots only (#1108): this set becomes replace-element's
        // affected shots — a soft-deleted shot must not get its still edited.
        // (cascadeRename above deliberately scans ALL rows: a restored shot
        // must come back carrying the renamed token.)
        db
          .select()
          .from(shots)
          .where(
            and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
          ) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
        loadVisualPromptsByShotId(db, sequenceId),
      ]);

      return allShots
        .filter((shot) => {
          const scene = resolveSceneForShot(shot, sceneContext).scene;
          return (
            matchElementsToShotImage([element], {
              visualPrompt: promptByShotId.get(shot.id),
              elementTags: scene?.continuity?.elementTags,
              sceneExtract: scene?.originalScript?.extract,
            }).length > 0
          );
        })
        .map((f) => f.id);
    },

    /**
     * Shot counts for *all* elements in a sequence, computed in a single
     * scan over shots + elements. The elements grid renders N cards, each
     * of which previously called `getShotIdsForElement` — an N+1 over the
     * full shot set. Returns an `elementId → count` map; elements with zero
     * matches are pre-seeded so the grid can render `Used in 0 shots`
     * instead of `undefined`.
     */
    getShotCountsByElement: async (
      sequenceId: string
    ): Promise<Record<string, { shotCount: number; videoCount: number }>> => {
      const allElements = await db
        .select()
        .from(sequenceElements)
        .where(
          and(
            eq(sequenceElements.sequenceId, sequenceId),
            isNull(sequenceElements.deletedAt)
          )
        );
      const counts: Record<string, { shotCount: number; videoCount: number }> =
        {};
      for (const el of allElements) {
        counts[el.id] = { shotCount: 0, videoCount: 0 };
      }
      if (allElements.length === 0) return counts;

      const [allShots, sceneContext, shotIdsWithVideo, promptByShotId] =
        await Promise.all([
          // Live shots only — "used in N shots" must not count hidden ones.
          db
            .select()
            .from(shots)
            .where(
              and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
            ) as Promise<Shot[]>,
          loadSceneContextBySequenceFromDb(db, sequenceId),
          // A shot "has video" when its render segment points at a live version
          // (#1067 phase 2d) — the `shots.videoUrl` mirror is gone.
          db
            .select({ shotId: shots.id })
            .from(shots)
            .innerJoin(
              renderSegments,
              eq(renderSegments.id, shots.renderSegmentId)
            )
            .innerJoin(
              videoVariants,
              and(
                eq(videoVariants.id, renderSegments.selectedVideoVersionId),
                isNull(videoVariants.discardedAt)
              )
            )
            .where(eq(shots.sequenceId, sequenceId))
            .then((rows) => new Set(rows.map((r) => r.shotId))),
          loadVisualPromptsByShotId(db, sequenceId),
        ]);

      for (const shot of allShots) {
        const scene = resolveSceneForShot(shot, sceneContext).scene;
        const matched = matchElementsToShotImage(allElements, {
          visualPrompt: promptByShotId.get(shot.id),
          elementTags: scene?.continuity?.elementTags,
          sceneExtract: scene?.originalScript?.extract,
        });
        const hasVideo = shotIdsWithVideo.has(shot.id);
        for (const el of matched) {
          const entry = counts[el.id];
          if (!entry) continue;
          entry.shotCount += 1;
          if (hasVideo) entry.videoCount += 1;
        }
      }
      return counts;
    },
  };
}
