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
import { generateId } from '@/platform/id';
import { isEngineAbortError } from '@/platform/server/workflow/errors';
import type { WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';
import {
  characterBibleVersions,
  characters,
  frameVariants,
  frames,
  videoVariants,
  locationBibleVersions,
  locations,
  scenes,
  sequenceCast,
  sequenceElements,
  sequenceEvents,
  sequenceLocationLinks,
  shotDialogueClaims,
  shots,
  styles,
  user,
} from '@/platform/server/db/schema';
import type {
  SequenceEvent,
  SequenceEventData,
  SequenceEventTargetType,
} from '@/platform/server/db/schema';
import { and, desc, eq, inArray, lt, notExists, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  displaySummary,
  historyChanges,
  mediaVersionIds,
  styleIdsInHistoryData,
} from '@/sequences/history-changes';
import type { HistoryChange, HistoryScope } from '@/sequences/history-changes';
import { videoPosterUrl } from '@/look/cloudflare-video';
import { toCdnUrl } from '@/platform/server/storage/buckets';
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

/**
 * The select list of an insert-select. Drizzle wants every table column, in
 * table order, so the sequence id (a bound value or a joined column) is
 * passed in and placed here.
 */
function eventColumns<S>(
  input: Omit<RecordEventInput, 'sequenceId'> & { id: string },
  sequenceId: S
) {
  return {
    id: bound(input.id, 'id'),
    sequenceId,
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
 * writes nothing. `where` is that gate. A retry adds no second line only when
 * the caller passes a stable id or gates on {@link eventNotLogged}.
 */
export function buildEventInsertIfPresent(
  db: Database,
  input: RecordEventInput & { id: string },
  source: SQLiteTable,
  where: SQL | undefined
) {
  return db
    .insert(sequenceEvents)
    .select(
      db
        .select(eventColumns(input, bound(input.sequenceId, 'sequence_id')))
        .from(source)
        .where(where)
        .limit(1)
    )
    .onConflictDoNothing();
}

/**
 * True while no `kind` line of this sequence carries `data[key] = value`.
 * A completion line takes a fresh id so it sorts when it is written, not when
 * its run started; this gate is what stops a retried step adding a second.
 */
export function eventNotLogged(
  db: Database,
  sequenceId: string,
  kind: string,
  key: string,
  value: string
): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(sequenceEvents)
      .where(
        and(
          eq(sequenceEvents.sequenceId, sequenceId),
          eq(sequenceEvents.kind, kind),
          sql`json_extract(${sequenceEvents.data}, ${`$.${key}`}) = ${value}`
        )
      )
  );
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
  const columns = eventColumns(
    {
      id: input.id,
      actorId: input.actorId,
      kind: 'dialogue.started',
      targetType: 'shot',
      targetId: input.targetId,
      summary: 'Started recording dialogue',
    },
    shots.sequenceId
  );
  return db
    .insert(sequenceEvents)
    .select(
      db
        .select(columns)
        .from(shotDialogueClaims)
        .innerJoin(shots, eq(shots.id, shotDialogueClaims.shotId))
        .where(eq(shotDialogueClaims.id, input.id))
        .limit(1)
    )
    .onConflictDoNothing();
}

/**
 * A run's own history line, in its own step after the work it describes.
 * History never fails that work: a line that cannot be written is logged and
 * the run goes on. The id is checkpointed first, so a retried insert adds no
 * second line.
 */
export async function logRunEvent(
  step: WorkflowStep,
  events: {
    recordOnce: (input: RecordEventInput & { id: string }) => Promise<void>;
  },
  name: string,
  input: RecordEventInput
): Promise<void> {
  try {
    const id = await step.do(`${name}-event-id`, async () => generateId());
    await step.do(`${name}-event`, async () => {
      await events.recordOnce({ ...input, id });
    });
  } catch (error) {
    if (isEngineAbortError(error)) throw error;
    getLogger(['openstory', 'sequence-events']).error(
      'activity-log line was not written',
      { err: error, kind: input.kind, sequenceId: input.sequenceId }
    );
  }
}

/**
 * A trigger that never became a run. The shared workflow failure step cannot
 * see it. A failed log must not replace the trigger error.
 */
export async function recordTriggerFailure(
  events: { record: (input: RecordEventInput) => Promise<unknown> },
  input: RecordEventInput
): Promise<void> {
  try {
    await events.record(input);
  } catch (error) {
    getLogger(['openstory', 'sequence-events']).error(
      'activity-log failure was not written',
      { err: error, kind: input.kind, sequenceId: input.sequenceId }
    );
  }
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

/** A stored still, or a Cloudflare JPEG of a clip's first frame. */
export type HistoryPreview = {
  url: string;
  model: string;
};

export type HistoryEntry = {
  id: string;
  kind: string;
  summary: string;
  actorName: string;
  createdAt: string;
  /** The row the event points at. Used to pair a render with its auto-select. */
  targetId: string;
  /** The media version the event stored, when it stored one. */
  versionId: string | null;
  targetLabel: string;
  link: HistoryLink | null;
  /** From → to, or the previous text when that is all the event kept. */
  changes: HistoryChange[];
  /** The still this event names. A clip uses a Cloudflare frame JPEG when the zone can extract one. */
  preview: HistoryPreview | null;
  /** The still it replaced, when the event stored that version id. */
  previousPreview: HistoryPreview | null;
};

export type HistoryPage = {
  events: HistoryEntry[];
  nextCursor: string | null;
};

const HISTORY_PAGE_SIZE = 40;

/**
 * Events for the shots `shotMatch` names, including their frames, stills, and
 * clips. A packed clip counts when any manifest entry is one of those shots.
 */
function eventsForShots(
  db: Database,
  sequenceId: string,
  shotMatch: SQL
): SQL | undefined {
  const shotWhere = and(eq(shots.sequenceId, sequenceId), shotMatch);
  const shotIds = db.select({ id: shots.id }).from(shots).where(shotWhere);
  const frameIds = db
    .select({ id: frames.id })
    .from(frames)
    .innerJoin(shots, eq(shots.id, frames.shotId))
    .where(and(eq(frames.sequenceId, sequenceId), shotMatch));
  const stillIds = db
    .select({ id: frameVariants.id })
    .from(frameVariants)
    .innerJoin(frames, eq(frames.id, frameVariants.frameId))
    .innerJoin(shots, eq(shots.id, frames.shotId))
    .where(and(eq(frameVariants.sequenceId, sequenceId), shotMatch));
  const clipIds = db
    .select({ id: videoVariants.id })
    .from(videoVariants)
    .where(
      and(
        eq(videoVariants.sequenceId, sequenceId),
        sql`exists (
          select 1 from json_each(${videoVariants.manifest}) as je
          where json_extract(je.value, '$.shotId') in ${shotIds}
        )`
      )
    );
  return or(
    and(
      eq(sequenceEvents.targetType, 'shot'),
      inArray(sequenceEvents.targetId, shotIds)
    ),
    and(
      eq(sequenceEvents.targetType, 'frame'),
      inArray(sequenceEvents.targetId, frameIds)
    ),
    and(
      eq(sequenceEvents.targetType, 'variant'),
      or(
        inArray(sequenceEvents.targetId, stillIds),
        inArray(sequenceEvents.targetId, clipIds)
      )
    )
  );
}

function historyScopeFilter(
  db: Database,
  sequenceId: string,
  scope: HistoryScope | undefined
): SQL | undefined {
  if (!scope) return undefined;
  if ('shotId' in scope) {
    return eventsForShots(db, sequenceId, eq(shots.id, scope.shotId));
  }
  if (scope.sceneIds.length === 0) return sql`0`;
  // The scene list is matched five times in this one statement. As a JSON
  // array it is one bound value each time; an `in (?, ?, …)` list would pass
  // D1's 100-parameter limit at about 18 scenes.
  const sceneIds = JSON.stringify(scope.sceneIds);
  const inScenes = (column: SQL | typeof shots.sceneId) =>
    sql`${column} in (select value from json_each(${sceneIds}))`;
  return or(
    and(
      eq(sequenceEvents.targetType, 'scene'),
      inScenes(sql`${sequenceEvents.targetId}`)
    ),
    eventsForShots(db, sequenceId, inScenes(shots.sceneId))
  );
}

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

    /**
     * Insert under a caller-chosen id. A retried step that commits the same
     * id no-ops. Does not throw when the row is already there.
     */
    recordOnce: async (
      input: RecordEventInput & { id: string }
    ): Promise<void> => {
      await buildEventInsertOnce(db, input);
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
     * shown (`id < before`). A paged `pageOf` is oldest-first, so this read
     * does not use it.
     */
    listHistory: async (
      sequenceId: string,
      options?: {
        before?: string;
        limit?: number;
        scope?: HistoryScope;
      }
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
            options?.before ? lt(sequenceEvents.id, options.before) : undefined,
            historyScopeFilter(db, sequenceId, options?.scope)
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
      const styleIds = [
        ...new Set(
          page.flatMap((row) => styleIdsInHistoryData(row.event.data))
        ),
      ];
      const mediaIds = [
        ...new Set(
          page.flatMap((row) => {
            const ids = mediaVersionIds(row.event.data);
            return [ids.versionId, ids.prevVersionId].filter(
              (id): id is string => id != null
            );
          })
        ),
      ];
      const [
        shotRows,
        sceneRows,
        characterRows,
        locationRows,
        elementRows,
        frameRows,
        variantRows,
        videoRows,
        styleRows,
        imageVersionRows,
        videoVersionRows,
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
                id: locations.id,
                deletedAt: locations.deletedAt,
                name: locationBibleVersions.name,
                linkId: sequenceLocationLinks.id,
                removedAt: sequenceLocationLinks.removedAt,
              })
              .from(locations)
              .leftJoin(
                locationBibleVersions,
                eq(locationBibleVersions.id, locations.selectedBibleVersionId)
              )
              .leftJoin(
                sequenceLocationLinks,
                and(
                  eq(sequenceLocationLinks.locationId, locations.id),
                  eq(sequenceLocationLinks.sequenceId, sequenceId)
                )
              )
              .where(inArray(locations.id, ids('location'))),
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
                url: frameVariants.url,
                model: frameVariants.model,
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
        ids('variant').length === 0
          ? []
          : db
              .select({
                id: videoVariants.id,
                manifest: videoVariants.manifest,
                url: videoVariants.url,
                model: videoVariants.model,
              })
              .from(videoVariants)
              .where(
                and(
                  eq(videoVariants.sequenceId, sequenceId),
                  inArray(videoVariants.id, ids('variant'))
                )
              ),
        styleIds.length === 0
          ? []
          : db
              .select({ id: styles.id, name: styles.name })
              .from(styles)
              .where(inArray(styles.id, styleIds)),
        mediaIds.length === 0
          ? []
          : db
              .select({
                id: frameVariants.id,
                url: frameVariants.url,
                model: frameVariants.model,
              })
              .from(frameVariants)
              .where(
                and(
                  eq(frameVariants.sequenceId, sequenceId),
                  inArray(frameVariants.id, mediaIds)
                )
              ),
        mediaIds.length === 0
          ? []
          : db
              .select({
                id: videoVariants.id,
                manifest: videoVariants.manifest,
                url: videoVariants.url,
                model: videoVariants.model,
              })
              .from(videoVariants)
              .where(
                and(
                  eq(videoVariants.sequenceId, sequenceId),
                  inArray(videoVariants.id, mediaIds)
                )
              ),
      ]);
      const styleNames = new Map(
        styleRows.map((style) => [style.id, style.name])
      );

      const byId = <T extends { id: string }>(list: T[]) =>
        new Map(list.map((row) => [row.id, row]));
      const sceneById = byId(sceneRows);
      const characterById = byId(characterRows);
      const locationById = byId(locationRows);
      const elementById = byId(elementRows);
      const frameById = byId(frameRows);
      const variantById = byId(variantRows);
      const videoShotIds = [
        ...new Set(
          videoRows.flatMap((row) => {
            const shotId = row.manifest[0]?.shotId;
            return shotId ? [shotId] : [];
          })
        ),
      ];
      const knownShotIds = new Set(shotRows.map((shot) => shot.id));
      const missingVideoShotIds = videoShotIds.filter(
        (id) => !knownShotIds.has(id)
      );
      const videoById = byId(videoRows);
      const imageVersionById = byId(imageVersionRows);
      const videoVersionById = byId(videoVersionRows);
      const posterFrameIds = [
        ...new Set(
          [...videoRows, ...videoVersionRows].flatMap((row) => {
            const frameId = row.manifest[0]?.frameVersionId;
            if (!frameId) return [];
            if (imageVersionById.has(frameId) || variantById.has(frameId)) {
              return [];
            }
            return [frameId];
          })
        ),
      ];
      const [extraShots, posterFrames] = await Promise.all([
        missingVideoShotIds.length === 0
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
                  inArray(shots.id, missingVideoShotIds)
                )
              ),
        posterFrameIds.length === 0
          ? []
          : db
              .select({
                id: frameVariants.id,
                url: frameVariants.url,
                model: frameVariants.model,
              })
              .from(frameVariants)
              .where(
                and(
                  eq(frameVariants.sequenceId, sequenceId),
                  inArray(frameVariants.id, posterFrameIds)
                )
              ),
      ]);
      const shotById = new Map<
        string,
        {
          id: string;
          shotNumber: number | null;
          deletedAt: Date | null;
        }
      >();
      for (const shot of shotRows) shotById.set(shot.id, shot);
      for (const shot of extraShots) shotById.set(shot.id, shot);
      const posterById = byId(posterFrames);

      const stillFor = (
        frameId: string | null
      ): { url: string; model: string } | null => {
        if (!frameId) return null;
        const row =
          imageVersionById.get(frameId) ??
          posterById.get(frameId) ??
          variantById.get(frameId);
        if (!row?.url) return null;
        return { url: row.url, model: row.model };
      };

      // A clip previews as a Cloudflare JPEG of its first frame
      // (`cdn-cgi/media/mode=frame`). The browser requests that image. The
      // clip file is not a history URL. Off-zone and local `/r2` clips have
      // no transform, so they fall back to the start frame on the manifest.
      const videoPreview = (video: {
        url: string | null;
        model: string;
        manifest: { frameVersionId?: string | null }[];
      }): HistoryPreview | null => {
        if (video.url) {
          const source = toCdnUrl(video.url) ?? video.url;
          const poster = videoPosterUrl(source, 192);
          if (poster) return { url: poster, model: video.model };
        }
        const still = stillFor(video.manifest[0]?.frameVersionId ?? null);
        if (!still) return null;
        return { url: still.url, model: video.model };
      };

      const mediaPreview = (id: string | null): HistoryPreview | null => {
        if (!id) return null;
        const image = imageVersionById.get(id);
        if (image?.url) return { url: image.url, model: image.model };
        const video = videoVersionById.get(id) ?? videoById.get(id);
        if (!video) return null;
        return videoPreview(video);
      };

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
        let preview: HistoryPreview | null = null;
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
            location &&
            isNullDate(location.deletedAt) &&
            location.linkId != null &&
            isNullDate(location.removedAt)
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
        } else if (event.targetType === 'frame') {
          const hit = frameById.get(targetId);
          targetLabel = hit ? `Shot ${hit.shotNumber}` : 'Shot';
          link =
            hit && isNullDate(hit.deletedAt)
              ? scenesLink({ shot: hit.shotId })
              : null;
        } else if (event.targetType === 'variant') {
          const frameHit = variantById.get(targetId);
          const videoHit = videoById.get(targetId);
          const videoShotId = videoHit?.manifest[0]?.shotId;
          const videoShot = videoShotId ? shotById.get(videoShotId) : undefined;
          if (frameHit) {
            targetLabel = `Shot ${frameHit.shotNumber}`;
            link = isNullDate(frameHit.deletedAt)
              ? scenesLink({ shot: frameHit.shotId })
              : null;
            if (frameHit.url) {
              preview = { url: frameHit.url, model: frameHit.model };
            }
          } else if (videoShot) {
            targetLabel = `Shot ${videoShot.shotNumber}`;
            link = isNullDate(videoShot.deletedAt)
              ? scenesLink({ shot: videoShot.id })
              : null;
          } else if (videoShotId) {
            targetLabel = 'Shot';
            link = null;
          } else {
            targetLabel = 'Clip';
            link = null;
          }
          if (!preview && videoHit) {
            preview = videoPreview(videoHit);
          }
        } else {
          // A new target type fails this assignment instead of linking as
          // the sequence.
          event.targetType satisfies 'sequence';
          targetLabel = 'Sequence';
          link = scenesLink({});
        }
        const versions = mediaVersionIds(event.data);
        return {
          id: event.id,
          kind: event.kind,
          summary: displaySummary(
            event.summary ?? event.kind.replaceAll('.', ' '),
            event.data
          ),
          actorName: actorName ?? 'OpenStory',
          createdAt: event.createdAt.toISOString(),
          targetId: event.targetId,
          versionId: versions.versionId,
          targetLabel,
          link,
          changes: historyChanges(event.data, styleNames),
          preview: mediaPreview(versions.versionId) ?? preview,
          previousPreview: mediaPreview(versions.prevVersionId),
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
 * Event appended by `scopedDb.sequences.update` when a sequence setting
 * changes: style, aspect ratio, a model, or the generation stop. Style and
 * aspect ratio switches leave no timestamp on any row (style is a snapshot),
 * so this is the only way to date them for `findStalenessCauses` (#1194).
 *
 * Model switches are not a staleness cause (#1785): a switch applies to the
 * next generation and never stales what exists. `SETTINGS_CHANGED_LABELS`
 * stays style and aspect ratio, which is what staleness reads.
 */
export const SETTINGS_CHANGED_EVENT = 'sequence.settings-changed';

export const SETTINGS_CHANGED_LABELS: Record<string, string> = {
  styleId: 'Style',
  aspectRatio: 'Aspect ratio',
};
