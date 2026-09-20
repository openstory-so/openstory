/**
 * Authored dialogue for a shot (#1657): the one place the lines live.
 *
 * The scene script's `originalScript.dialogue` is the LLM's extraction and
 * stays as the seed. This table is what References, render and staleness
 * read. Lines belong to the SHOT, so the speaking order of a scene is shot
 * order, then line order within the shot — there is no scene-level line list,
 * and a reorder or an edit to one shot touches nobody else's row.
 *
 * Append-only with one selected row per shot. A user edit appends a
 * `user-edit` row; the shot-list pass seeds a `prompt` row. A shot from
 * before this table is derived at read time from the selected script version
 * (`deriveShotDialogueLines`), so no backfill migration is needed.
 */
import { sql, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { shots } from './shots';

/** One authored line of a shot. */
export type ShotDialogueLine = {
  /** Speaker, spelled as the cast list spells it; empty = unattributed. */
  character: string;
  line: string;
  tone: string;
  /**
   * User-bound voice (#1559): unset = TTS when the speaker has a voice;
   * `DIALOGUE` = bind the conversation clip; `__video_model__` = the video
   * model invents the voice; any other string = an uploaded audio element.
   */
  voiceToken?: string;
};

const SHOT_DIALOGUE_SOURCES = ['prompt', 'user-edit'] as const;
export type ShotDialogueSource = (typeof SHOT_DIALOGUE_SOURCES)[number];

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
    lines: text({ mode: 'json' }).$type<ShotDialogueLine[]>().notNull(),
    source: text().$type<ShotDialogueSource>().notNull(),
    selectedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_shot_dialogue_versions_shot_created').on(
      table.shotId,
      table.createdAt
    ),
    uniqueIndex('uq_shot_dialogue_versions_selected')
      .on(table.shotId)
      .where(sql`${table.selectedAt} IS NOT NULL`),
  ]
);

export type ShotDialogueVersion = InferSelectModel<typeof shotDialogueVersions>;
