/**
 * Scoped Sequence Elements Sub-module
 * Element CRUD for per-sequence uploaded reference images.
 */

import type { Database } from '@/platform/server/db/client';
import type {
  ElementVisionStatus,
  Shot,
  NewSequenceElement,
  SequenceElement,
} from '@/platform/server/db/schema';
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
} from '@/platform/server/db/schema';
import {
  buildShotRenameDeltas,
  replaceTokenInText,
  renameTokenInContinuity,
} from '@/cast/cascade-rename';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import { matchElementsToShotImage } from '@/shots/scene-matching';
import { promoteLegacyMotionDialogue } from '@/shots/server/db/shot-prompt-versions';
import { generateId } from '@/platform/id';
import { sceneNarrativeOf } from '@/shots/scene-narrative';
import { joinSelectedScript, sceneColumns } from '@/shots/server/db/scenes';
import { and, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';

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
    list: async (
      sequenceId: string,
      page?: PageOptions
    ): Promise<SequenceElement[]> => {
      return await pageOf(
        db.select().from(sequenceElements).$dynamic(),
        and(
          eq(sequenceElements.sequenceId, sequenceId),
          isNull(sequenceElements.deletedAt)
        ),
        sequenceElements.id,
        page,
        sequenceElements.createdAt
      );
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
     * across the sequence: `sequences.script`, the selected
     * `scene_script_versions` extract and continuity (one `renamed` row,
     * #1600), the anchor frame's `imagePrompt` and the selected
     * `shot_prompt_versions` motion text.
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
          prompt: framePromptVersions,
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
        frameRows.map((f) => [f.shotId, f.prompt?.text ?? null])
      );
      const selectedImagePromptByShot = new Map(
        frameRows.flatMap((f) => (f.prompt ? [[f.shotId, f.prompt]] : []))
      );
      // The motion prompt is the *selected* `shot_prompt_versions` row (#713):
      // both the token scan and the rewrite target that row.
      const selectedMotionRows = await db
        .select({ shotId: shots.id, version: shotPromptVersions })
        .from(shots)
        .innerJoin(
          shotPromptVersions,
          eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
        )
        .where(eq(shots.sequenceId, sequenceId));
      const motionPromptByShot = new Map(
        selectedMotionRows.map((r) => [r.shotId, r.version.text])
      );
      const selectedMotionVersionByShot = new Map(
        selectedMotionRows.map((r) => [r.shotId, r.version])
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
        .select({
          sceneId: scenes.id,
          scene: sceneColumns,
          version: sceneScriptVersions,
        })
        .from(scenes)
        .innerJoin(sceneScriptVersions, joinSelectedScript)
        .where(eq(scenes.sequenceId, sequenceId));
      // Version rows are append-only history (#1786): a rename appends a
      // `renamed` row carrying the rewritten text and repoints the selection at
      // it — never rewrites the selected row in place, which would make every
      // still, clip and hash that pinned that row claim text it never saw. Each
      // repoint is a compare-and-swap on the pointer this read saw, so an edit
      // or select that lands meanwhile keeps its choice. Element tags live on
      // the scene's continuity, which rides the same row as the text (#1600),
      // so one row carries both rewrites.
      const sceneScriptStatements = selectedScriptRows.flatMap(
        ({ sceneId, scene, version }) => {
          const extract = version.content.extract;
          const rewritten = extract
            ? replaceTokenInText(extract, oldToken, newToken)
            : extract;
          const continuity = scene.continuity
            ? renameTokenInContinuity(scene.continuity, oldToken, newToken)
            : null;
          if (rewritten === extract && !continuity) return [];
          const id = generateId();
          return [
            db.insert(sceneScriptVersions).values({
              id,
              sceneId,
              content: { ...version.content, extract: rewritten },
              ...sceneNarrativeOf(scene),
              ...(continuity ? { continuity } : {}),
              source: 'renamed',
            }),
            db
              .update(scenes)
              .set({ selectedScriptVersionId: id, updatedAt: now })
              .where(
                and(
                  eq(scenes.id, sceneId),
                  eq(scenes.selectedScriptVersionId, version.id)
                )
              ),
          ];
        }
      );

      // A pre-#1657 shot keeps its lines only on the selected motion row;
      // lift them to the dialogue node before a new row takes the selection.
      for (const delta of deltas) {
        if (
          delta.motionPrompt !== undefined &&
          selectedMotionVersionByShot.has(delta.shotId)
        ) {
          await promoteLegacyMotionDialogue(db, delta.shotId);
        }
      }

      const shotStatements = deltas.flatMap((delta) => {
        const motion = selectedMotionVersionByShot.get(delta.shotId);
        const image = selectedImagePromptByShot.get(delta.shotId);
        const motionId = generateId();
        const imageId = generateId();
        return [
          ...(delta.motionPrompt !== undefined && motion
            ? [
                db.insert(shotPromptVersions).values({
                  id: motionId,
                  shotId: motion.shotId,
                  promptType: motion.promptType,
                  text: delta.motionPrompt,
                  components: motion.components,
                  parameters: motion.parameters,
                  audio: motion.audio,
                  usesStartFrame: motion.usesStartFrame,
                  source: 'renamed',
                  inputHash: motion.inputHash,
                  analysisModel: motion.analysisModel,
                }),
                db
                  .update(shots)
                  .set({
                    selectedMotionPromptVersionId: motionId,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(shots.id, motion.shotId),
                      eq(shots.selectedMotionPromptVersionId, motion.id)
                    )
                  ),
              ]
            : []),
          ...(delta.imagePrompt !== undefined && image
            ? [
                db.insert(framePromptVersions).values({
                  id: imageId,
                  frameId: image.frameId,
                  text: delta.imagePrompt,
                  components: image.components,
                  source: 'renamed',
                  inputHash: image.inputHash,
                  analysisModel: image.analysisModel,
                }),
                db
                  .update(frames)
                  .set({
                    selectedImagePromptVersionId: imageId,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(frames.id, image.frameId),
                      eq(frames.selectedImagePromptVersionId, image.id)
                    )
                  ),
              ]
            : []),
        ];
      });

      const [elementRows] = await db.batch([
        elementUpdate,
        ...scriptStatements,
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
