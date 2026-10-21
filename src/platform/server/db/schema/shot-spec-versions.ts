/**
 * A shot's spec (#1915): framing, action, camera move, pacing, direction and
 * sound cue — the structured shot-list entry its still and motion prompts
 * are derived from. Append-only; `shots.selectedSpecVersionId` points at the
 * current one. Prompt versions record the `specVersionId` they were built
 * from, so framing is stored once.
 *
 * Shot number, duration and lines are not here: they live on `shots` and
 * `shot_dialogue_versions`. A shot from before this table has no row and
 * keeps its prompt text as written; nothing backfills it.
 */
import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import type { StoredShotSpec } from '@/shots/shot-list.schema';
import { user } from './auth';
import { shots } from './shots';

/**
 * `analysis`: the shot-list pass wrote it.
 * `rewrite`: Rewrite shot refilled it (#1923).
 * `rename`: an element-token rename rewrote its strings.
 * `edit`: the user edited it in the shot inspector (#1929).
 */
const SHOT_SPEC_SOURCES = ['analysis', 'rewrite', 'rename', 'edit'] as const;
export type ShotSpecSource = (typeof SHOT_SPEC_SOURCES)[number];

export const shotSpecVersions = snakeCase.table(
  'shot_spec_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    spec: text({ mode: 'json' }).$type<StoredShotSpec>().notNull(),
    source: text({ enum: SHOT_SPEC_SOURCES }).notNull(),
    /**
     * What this version was written from: the scene's script slice, this
     * shot's lines, and the scene's cast / continuity tags (#1923). Null on
     * a row from before the column — treated as current, so analysis rows
     * are not a Rewrite. Rebuild fills it in place.
     */
    inputHash: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_shot_spec_versions_shot_created').on(
      table.shotId,
      table.createdAt
    ),
  ]
);

export type ShotSpecVersion = InferSelectModel<typeof shotSpecVersions>;
