/**
 * Sequence Events Schema — append-only activity log.
 *
 * The single linear, cross-sequence timeline of every change: image/video
 * generations, prompt edits, version selections (revert/switch-model), shot
 * add/remove/reorder, model add/remove. It is **log-over-truth**, NOT
 * event-sourcing — the domain tables stay authoritative and this narrates
 * changes and references them (an `image.generated` event carries the new
 * frame_variants version id in `data`).
 *
 * Rows are never updated. To avoid drift, the event is appended in the SAME
 * `db.batch()` transaction as the mutation, from the scoped-db write layer —
 * change and event commit together or not at all.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { sequences } from './sequences';

/** What kind of change occurred. Open-ended by design (string, not enum) so new
 * event kinds don't need a migration; documented values are the current set.
 * @public consumed from #988+ */
export const SEQUENCE_EVENT_TARGET_TYPES = [
  'sequence',
  'scene',
  'shot',
  'frame',
  'variant',
  'character',
  'location',
  'element',
] as const;
export type SequenceEventTargetType =
  (typeof SEQUENCE_EVENT_TARGET_TYPES)[number];

/** Precise recursive JSON type for the `data` payload (no `unknown`). */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type SequenceEventData = { [key: string]: JsonValue };

export const sequenceEvents = snakeCase.table(
  'sequence_events',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(), // ULID → global time order
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Actor; null for system / AI / workflow-originated events.
    actorId: text().references(() => user.id, { onDelete: 'set null' }),
    // e.g. 'image.generated' | 'image.selected' | 'prompt.edited'
    // | 'video.rendered' | 'shot.added' | 'shot.removed' | 'shots.reordered'
    // | 'model.added'. String (not enum) — additive without migrations.
    kind: text().notNull(),
    targetType: text().$type<SequenceEventTargetType>().notNull(),
    targetId: text().notNull(),
    // Denormalized human string for cheap timeline rendering.
    summary: text(),
    // Specifics: model, versionId, from→to, prevPointer (enables undo), ...
    data: text({ mode: 'json' }).$type<SequenceEventData>(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // The timeline query: WHERE sequence_id=? ORDER BY id DESC.
    index('idx_sequence_events_sequence').on(table.sequenceId, table.id),
    // "What happened to this entity": filter by target.
    index('idx_sequence_events_target').on(table.targetType, table.targetId),
  ]
);

/** @public consumed from #988+ */
export type SequenceEvent = InferSelectModel<typeof sequenceEvents>;
/** @public consumed from #988+ */
export type NewSequenceEvent = InferInsertModel<typeof sequenceEvents>;
