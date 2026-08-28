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

import type { Database } from '@/lib/db/client';
import { sequenceEvents } from '@/lib/db/schema';
import type {
  SequenceEvent,
  SequenceEventData,
  SequenceEventTargetType,
} from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

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
      options?: { limit?: number }
    ): Promise<SequenceEvent[]> => {
      let query = db
        .select()
        .from(sequenceEvents)
        .where(eq(sequenceEvents.sequenceId, sequenceId))
        .orderBy(desc(sequenceEvents.id))
        .$dynamic();
      if (options?.limit) {
        query = query.limit(options.limit);
      }
      return await query;
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
 * setting changes (#1194). Style / aspect ratio / model switches leave no
 * timestamp on any row (style is a snapshot), so this is the only way to date
 * them for `findStalenessCauses`.
 */
export const SETTINGS_CHANGED_EVENT = 'sequence.settings-changed';

export const SETTINGS_CHANGED_LABELS: Record<string, string> = {
  styleId: 'Style',
  aspectRatio: 'Aspect ratio',
  imageModel: 'Image model',
  analysisModel: 'Script model',
};
