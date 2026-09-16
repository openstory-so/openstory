/** Append-only generated dialogue takes for a shot (#1657). */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import type { MotionAudioClip } from './shot-prompt-versions';
import { shots } from './shots';

export const shotDialogueVersions = snakeCase.table(
  'shot_dialogue_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    audioClips: text({ mode: 'json' }).$type<MotionAudioClip[]>().notNull(),
    /** Canonical voice id + line + tone + model dependency key. */
    inputHash: text().notNull(),
    workflowRunId: text(),
    selectedAt: integer({ mode: 'timestamp' }),
    discardedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_shot_dialogue_versions_shot_created').on(
      table.shotId,
      table.createdAt
    ),
    index('idx_shot_dialogue_versions_shot_hash').on(
      table.shotId,
      table.inputHash
    ),
    uniqueIndex('uq_shot_dialogue_versions_selected')
      .on(table.shotId)
      .where(sql`${table.selectedAt} IS NOT NULL`),
  ]
);
