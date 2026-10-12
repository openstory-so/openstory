/**
 * Scoped Sequence Events Sub-module — the append-only activity log.
 *
 * `sequence_events` narrates every change to a sequence (image generated,
 * selection repointed, prompt edited, shot added/reordered, …). It is
 * **log-over-truth**: the domain tables stay authoritative and an event merely
 * references the row it describes (e.g. an `image.selected` event carries the
 * new `frame_variants` version id in `data`).
 *
 * The drift-prevention rule (design doc § Sequence activity log): an event is
 * appended in the **same `db.batch()`** as the mutation it narrates, so the
 * change and its event commit together or not at all. Write methods elsewhere
 * compose {@link buildEventInsert} into their own batch; {@link
 * createSequenceEventsMethods.record} is the convenience for a standalone event.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characters,
  frameVariants,
  frames,
  locationBibleVersions,
  scenes,
  sequenceCast,
  sequenceElements,
  sequenceEvents,
  sequenceLocations,
  shotDialogueClaims,
  shots,
  user,
} from '@/platform/server/db/schema';
import type {
  SequenceEvent,
  SequenceEventData,
  SequenceEventTargetType,
} from '@/platform/server/db/schema';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { dbSceneId } from '@/shots/scene-id';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';

/**
 * One activity-log entry. `actorId` is null for system / AI / workflow-driven
 * changes; a user id when a person triggered it. `kind` is an open-ended dotted
 * string (e.g. `'image.generated'`, `'image.selected'`, `'prompt.edited'`) —
 * not an enum, so new kinds need no migration.
 */
export type RecordEventInput = {
  sequenceId: string;
  actorId: string | null;
  kind: string;
  targetType: SequenceEventTargetType;
  targetId: string;
  summary?: string | null;
  /** Specifics: model, versionId, from→to, prevPointer (enables undo), … */
  data?: SequenceEventData | null;
};

/**
 * Build the `sequence_events` insert statement WITHOUT executing it, so a
 * caller can append it to its own `db.batch([...mutations, eventInsert])` and
 * have the change + its event commit atomically. The row id / createdAt are
 * filled by the schema `$defaultFn`s.
 */
export function buildEventInsert(db: Database, input: RecordEventInput) {
  return db.insert(sequenceEvents).values({
    sequenceId: input.sequenceId,
    actorId: input.actorId,
    kind: input.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    summary: input.summary ?? null,
    data: input.data ?? null,
  });
}

const bound = (value: string | number | null, name: string) =>
  sql`${value}`.as(name);

function eventColumns(input: RecordEventInput & { id: string }) {
  return {
    id: bound(input.id, 'id'),
    sequenceId: bound(input.sequenceId, 'sequence_id'),
    actorId:
      input.actorId === null
        ? sql`null`.as('actor_id')
        : bound(input.actorId, 'actor_id'),
    kind: bound(input.kind, 'kind'),
    targetType: bound(input.targetType, 'target_type'),
    targetId: bound(input.targetId, 'target_id'),
    summary: bound(input.summary ?? null, 'summary'),
    data: bound(input.data == null ? null : JSON.stringify(input.data), 'data'),
    createdAt: bound(Math.floor(Date.now() / 1000), 'created_at'),
  };
}

/**
 * Insert one event under a caller-chosen id. A retried step that commits the
 * same id no-ops instead of appending a second line. `record` stays the
 * throwing path: a caller that needs the row back must not swallow a miss.
 */
export function buildEventInsertOnce(
  db: Database,
  input: RecordEventInput & { id: string }
) {
  return db
    .insert(sequenceEvents)
    .values({
      id: input.id,
      sequenceId: input.sequenceId,
      actorId: input.actorId,
      kind: input.kind,
      targetType: input.targetType,
      targetId: input.targetId,
      summary: input.summary ?? null,
      data: input.data ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Insert the event only when `source` has a matching row, so a lost claim
 * writes nothing and a retry hits the stable id. `where` is that gate.
 */
export function buildEventInsertIfPresent(
  db: Database,
  input: RecordEventInput & { id: string },
  source: SQLiteTable,
  where: SQL | undefined
) {
  return db
    .insert(sequenceEvents)
    .select(db.select(eventColumns(input)).from(source).where(where).limit(1))
    .onConflictDoNothing();
}

/**
 * A dialogue claim's start line. The sequence id comes off the shot, and the
 * insert lands only when THIS claim id exists — a unique-index refusal keeps
 * the other run's claim and writes no line here.
 */
export function buildDialogueStartEvent(
  db: Database,
  input: {
    id: string;
    actorId: string | null;
    targetId: string;
  }
) {
  const columns = eventColumns({
    id: input.id,
    sequenceId: '',
    actorId: input.actorId,
    kind: 'dialogue.started',
    targetType: 'shot',
    targetId: input.targetId,
    summary: 'Started recording dialogue',
  });
  return db
    .insert(sequenceEvents)
    .select(
      db
        .select({ ...columns, sequenceId: shots.sequenceId })
        .from(shotDialogueClaims)
        .innerJoin(shots, eq(shots.id, shotDialogueClaims.shotId))
        .where(eq(shotDialogueClaims.id, input.id))
        .limit(1)
    )
    .onConflictDoNothing();
}

/**
 * A workflow step's completion line. Workflow unit tests stub `scopedDb`
 * without this surface; a missing method is a stub, not a failed run.
 */
export async function recordSequenceEvent(
  db: {
    sequenceEvents?: {
      record: (input: RecordEventInput) => Promise<unknown>;
    };
  },
  input: RecordEventInput
): Promise<void> {
  await db.sequenceEvents?.record(input);
}

export type HistoryLink =
  | {
      to: '/sequences/$id/scenes';
      params: { id: string };
      search: { shot?: string; scenes?: string };
    }
  | {
      to: '/sequences/$id/cast/$characterId';
      params: { id: string; characterId: string };
    }
  | {
      to: '/sequences/$id/locations/$locationId';
      params: { id: string; locationId: string };
    }
  | {
      to: '/sequences/$id/elements/$elementId';
      params: { id: string; elementId: string };
    };

export type HistoryEntry = {
  id: string;
  kind: string;
  summary: string;
  actorName: string;
  createdAt: string;
  targetLabel: string;
  link: HistoryLink | null;
};

export type HistoryPage = {
  events: HistoryEntry[];
  nextCursor: string | null;
};

const HISTORY_PAGE_SIZE = 40;

function isNullDate(value: Date | null): boolean {
  return value == null;
}

export function createSequenceEventsMethods(db: Database) {
  return {
    /**
     * Append a standalone event (no accompanying domain mutation). When the
     * event narrates a mutation, prefer composing {@link buildEventInsert} into
     * the mutation's own `db.batch()` so they commit together.
     */
    record: async (input: RecordEventInput): Promise<SequenceEvent> => {
      const [row] = await buildEventInsert(db, input).returning();
      if (!row) {
        throw new Error(
          `Failed to record event ${input.kind} for sequence ${input.sequenceId}`
        );
      }
      return row;
    },

    /** The timeline: every event for a sequence, newest first (ULID order). */
    listBySequence: async (
      sequenceId: string,
      options?: {
        limit?: number;
        targetType?: SequenceEventTargetType;
        targetId?: string;
        kind?: string;
        page?: PageOptions;
      }
    ): Promise<SequenceEvent[]> => {
      let query = pageOf(
        db.select().from(sequenceEvents).$dynamic(),
        and(
          eq(sequenceEvents.sequenceId, sequenceId),
          options?.targetType
            ? eq(sequenceEvents.targetType, options.targetType)
            : undefined,
          options?.targetId
            ? eq(sequenceEvents.targetId, options.targetId)
            : undefined,
          options?.kind ? eq(sequenceEvents.kind, options.kind) : undefined
        ),
        sequenceEvents.id,
        options?.page,
        desc(sequenceEvents.id)
      );
      if (options?.limit) {
        query = query.limit(options.limit);
      }
      return await query;
    },

    getById: async (eventId: string): Promise<SequenceEvent | null> => {
      const [row] = await db
        .select()
        .from(sequenceEvents)
        .where(eq(sequenceEvents.id, eventId))
        .limit(1);
      return row ?? null;
    },

    /**
     * History page: newest first, cursor `before` is the oldest id already
     * shown (`id < before`). `pageOf` is oldest-first and is the wrong order.
     */
    listHistory: async (
      sequenceId: string,
      options?: { before?: string | null; limit?: number }
    ): Promise<HistoryPage> => {
      const limit = options?.limit ?? HISTORY_PAGE_SIZE;
      const rows = await db
        .select({
          event: sequenceEvents,
          actorName: user.name,
        })
        .from(sequenceEvents)
        .leftJoin(user, eq(user.id, sequenceEvents.actorId))
        .where(
          and(
            eq(sequenceEvents.sequenceId, sequenceId),
            options?.before ? lt(sequenceEvents.id, options.before) : undefined
          )
        )
        .orderBy(desc(sequenceEvents.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = (type: SequenceEventTargetType) =>
        page
          .filter((row) => row.event.targetType === type)
          .map((row) => row.event.targetId);

      const shotIds = ids('shot');
      const [
        shotRows,
        sceneRows,
        characterRows,
        locationRows,
        elementRows,
        frameRows,
        variantRows,
      ] = await Promise.all([
        shotIds.length === 0
          ? []
          : db
              .select({
                id: shots.id,
                shotNumber: shots.shotNumber,
                deletedAt: shots.deletedAt,
              })
              .from(shots)
              .where(
                and(
                  eq(shots.sequenceId, sequenceId),
                  inArray(shots.id, shotIds)
                )
              ),
        ids('scene').length === 0
          ? []
          : db
              .select({
                id: scenes.id,
                orderIndex: scenes.orderIndex,
                deletedAt: scenes.deletedAt,
              })
              .from(scenes)
              .where(
                and(
                  eq(scenes.sequenceId, sequenceId),
                  inArray(scenes.id, ids('scene').map(dbSceneId))
                )
              ),
        ids('character').length === 0
          ? []
          : db
              .select({
                id: characters.id,
                deletedAt: characters.deletedAt,
                name: characterBibleVersions.name,
                castId: sequenceCast.id,
                removedAt: sequenceCast.removedAt,
              })
              .from(characters)
              .leftJoin(
                characterBibleVersions,
                eq(characterBibleVersions.id, characters.selectedBibleVersionId)
              )
              .leftJoin(
                sequenceCast,
                and(
                  eq(sequenceCast.characterId, characters.id),
                  eq(sequenceCast.sequenceId, sequenceId)
                )
              )
              .where(inArray(characters.id, ids('character'))),
        ids('location').length === 0
          ? []
          : db
              .select({
                id: sequenceLocations.id,
                deletedAt: sequenceLocations.deletedAt,
                name: locationBibleVersions.name,
              })
              .from(sequenceLocations)
              .leftJoin(
                locationBibleVersions,
                eq(
                  locationBibleVersions.id,
                  sequenceLocations.selectedBibleVersionId
                )
              )
              .where(
                and(
                  eq(sequenceLocations.sequenceId, sequenceId),
                  inArray(sequenceLocations.id, ids('location'))
                )
              ),
        ids('element').length === 0
          ? []
          : db
              .select({
                id: sequenceElements.id,
                token: sequenceElements.token,
                deletedAt: sequenceElements.deletedAt,
              })
              .from(sequenceElements)
              .where(
                and(
                  eq(sequenceElements.sequenceId, sequenceId),
                  inArray(sequenceElements.id, ids('element'))
                )
              ),
        ids('frame').length === 0
          ? []
          : db
              .select({
                id: frames.id,
                shotId: frames.shotId,
                shotNumber: shots.shotNumber,
                deletedAt: shots.deletedAt,
              })
              .from(frames)
              .innerJoin(shots, eq(shots.id, frames.shotId))
              .where(
                and(
                  eq(frames.sequenceId, sequenceId),
                  inArray(frames.id, ids('frame'))
                )
              ),
        ids('variant').length === 0
          ? []
          : db
              .select({
                id: frameVariants.id,
                shotId: frames.shotId,
                shotNumber: shots.shotNumber,
                deletedAt: shots.deletedAt,
              })
              .from(frameVariants)
              .innerJoin(frames, eq(frames.id, frameVariants.frameId))
              .innerJoin(shots, eq(shots.id, frames.shotId))
              .where(
                and(
                  eq(frameVariants.sequenceId, sequenceId),
                  inArray(frameVariants.id, ids('variant'))
                )
              ),
      ]);

      const byId = <T extends { id: string }>(list: T[]) =>
        new Map(list.map((row) => [row.id, row]));
      const shotById = byId(shotRows);
      const sceneById = byId(sceneRows);
      const characterById = byId(characterRows);
      const locationById = byId(locationRows);
      const elementById = byId(elementRows);
      const frameById = byId(frameRows);
      const variantById = byId(variantRows);

      const scenesLink = (search: {
        shot?: string;
        scenes?: string;
      }): HistoryLink => ({
        to: '/sequences/$id/scenes',
        params: { id: sequenceId },
        search,
      });

      const events: HistoryEntry[] = page.map(({ event, actorName }) => {
        let targetLabel = 'Sequence';
        let link: HistoryLink | null = scenesLink({});
        const targetId = event.targetId;
        if (event.targetType === 'shot') {
          const shot = shotById.get(targetId);
          targetLabel = shot ? `Shot ${shot.shotNumber}` : 'Shot';
          link =
            shot && isNullDate(shot.deletedAt)
              ? scenesLink({ shot: shot.id })
              : null;
        } else if (event.targetType === 'scene') {
          const scene = sceneById.get(targetId);
          targetLabel = scene ? `Scene ${scene.orderIndex + 1}` : 'Scene';
          link =
            scene && isNullDate(scene.deletedAt)
              ? scenesLink({ scenes: scene.id })
              : null;
        } else if (event.targetType === 'character') {
          const character = characterById.get(targetId);
          targetLabel = character?.name || 'Character';
          link =
            character &&
            isNullDate(character.deletedAt) &&
            character.castId != null &&
            isNullDate(character.removedAt)
              ? {
                  to: '/sequences/$id/cast/$characterId',
                  params: { id: sequenceId, characterId: character.id },
                }
              : null;
        } else if (event.targetType === 'location') {
          const location = locationById.get(targetId);
          targetLabel = location?.name || 'Location';
          link =
            location && isNullDate(location.deletedAt)
              ? {
                  to: '/sequences/$id/locations/$locationId',
                  params: { id: sequenceId, locationId: location.id },
                }
              : null;
        } else if (event.targetType === 'element') {
          const element = elementById.get(targetId);
          targetLabel = element?.token || 'Element';
          link =
            element && isNullDate(element.deletedAt)
              ? {
                  to: '/sequences/$id/elements/$elementId',
                  params: { id: sequenceId, elementId: element.id },
                }
              : null;
        } else if (
          event.targetType === 'frame' ||
          event.targetType === 'variant'
        ) {
          const hit =
            event.targetType === 'frame'
              ? frameById.get(targetId)
              : variantById.get(targetId);
          if (!hit && event.targetType === 'variant') {
            targetLabel = 'Clip';
            link = null;
          } else {
            targetLabel = hit ? `Shot ${hit.shotNumber}` : 'Shot';
            link =
              hit && isNullDate(hit.deletedAt)
                ? scenesLink({ shot: hit.shotId })
                : null;
          }
        }
        return {
          id: event.id,
          kind: event.kind,
          summary: event.summary ?? event.kind.replaceAll('.', ' '),
          actorName: actorName ?? 'OpenStory',
          createdAt: event.createdAt.toISOString(),
          targetLabel,
          link,
        };
      });

      const last = page.at(-1);
      return {
        events,
        nextCursor: rows.length > limit && last ? last.event.id : null,
      };
    },

    /** "What happened to this entity": events targeting one frame/shot/scene. */
    listByTarget: async (
      targetType: SequenceEventTargetType,
      targetId: string
    ): Promise<SequenceEvent[]> => {
      return await db
        .select()
        .from(sequenceEvents)
        .where(
          and(
            eq(sequenceEvents.targetType, targetType),
            eq(sequenceEvents.targetId, targetId)
          )
        )
        .orderBy(desc(sequenceEvents.id));
    },
  };
}

/**
 * Event appended by `scopedDb.sequences.update` when a hash-bearing sequence
 * setting changes (#1194). Style / aspect ratio switches leave no timestamp
 * on any row (style is a snapshot), so this is the only way to date them for
 * `findStalenessCauses`.
 *
 * Model switches are not here (#1785): a switch applies to the next
 * generation and never stales what exists — verify pins the still's own
 * image model, the prompt's own analysis model and the sheet version's own
 * model, and clips ignore the video model. Naming them would blame a switch
 * for staleness it cannot cause.
 */
export const SETTINGS_CHANGED_EVENT = 'sequence.settings-changed';

export const SETTINGS_CHANGED_LABELS: Record<string, string> = {
  styleId: 'Style',
  aspectRatio: 'Aspect ratio',
};
