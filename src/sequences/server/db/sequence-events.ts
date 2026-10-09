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
import { sequenceEvents } from '@/platform/server/db/schema';
import type {
  SequenceEvent,
  SequenceEventData,
  SequenceEventTargetType,
} from '@/platform/server/db/schema';
import { and, desc, eq } from 'drizzle-orm';
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
