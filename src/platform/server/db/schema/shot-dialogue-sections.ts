/**
 * A shot's reading of its lines (#1657): a time range of a
 * `dialogue_recordings` row. A recording inserts one section for EVERY shot
 * it spoke — the shots it was made for are selected (`recorded`), the shots
 * that were only spoken as context are left unselected (`context`). Picking
 * any other row, an older reading or a context one, is the same selection.
 *
 * Holds no URL: the cut file is a cache (`cutAudioSection` materialises the
 * range to a deterministic R2 key) and `shots.audioClips` holds that URL. A
 * generated dialogue clip's `id` IS its section id.
 *
 * Append-only, one selected row per shot. `discardedAt` is honoured by reads;
 * nothing sets it yet.
 */
import { sql, type InferSelectModel } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { shots } from './shots';

const SHOT_DIALOGUE_SECTION_SOURCES = ['recorded', 'context'] as const;

export const shotDialogueSections = snakeCase.table(
  'shot_dialogue_sections',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    // Soft pointer (plain column, no FK) at the `dialogue_recordings` row.
    recordingId: text().notNull(),
    fromSeconds: real().notNull(),
    /** Already tail-trimmed. */
    toSeconds: real().notNull(),
    /** `dialogueClipSourceKey` of the AUTHORED voiced lines this section spoke. */
    sourceKey: text().notNull(),
    /** Delivered wording, only when a fit rewrite shortened it. */
    spokenLines: text({ mode: 'json' }).$type<
      { index: number; text: string }[]
    >(),
    /** The `shot_dialogue_versions` row spoken, when one existed. */
    dialogueVersionId: text(),
    source: text({ enum: SHOT_DIALOGUE_SECTION_SOURCES }).notNull(),
    selectedAt: integer({ mode: 'timestamp' }),
    discardedAt: integer({ mode: 'timestamp' }),
    workflowRunId: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_shot_dialogue_sections_shot_created').on(
      table.shotId,
      table.createdAt
    ),
    index('idx_shot_dialogue_sections_recording').on(table.recordingId),
    uniqueIndex('uq_shot_dialogue_sections_selected')
      .on(table.shotId)
      .where(sql`${table.selectedAt} IS NOT NULL`),
    check(
      'shot_dialogue_sections_range',
      sql`${table.fromSeconds} >= 0 AND ${table.toSeconds} > ${table.fromSeconds}`
    ),
    check(
      'shot_dialogue_sections_selected_not_discarded',
      sql`${table.discardedAt} IS NULL OR ${table.selectedAt} IS NULL`
    ),
  ]
);

export type ShotDialogueSection = InferSelectModel<typeof shotDialogueSections>;
