/**
 * Authored dialogue for a scene (#1657): the one place the lines live.
 *
 * The scene script's `originalScript.dialogue` is the LLM's extraction and
 * stays as the seed. This table is what References, render and staleness
 * read. Every line names the shot it is spoken in by `shotId` — an id, not a
 * number, so reorder needs no restamp and a deleted shot's lines stay
 * visible (and reassignable) instead of silently going unspoken.
 *
 * Append-only with one selected row per scene. A user edit appends a
 * `user-edit` row; the shot-list pass seeds a `prompt` row. Rows from before
 * this table are derived at read time from the selected script version
 * (`sceneDialogue.getSelected`), so no backfill migration is needed.
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
import { scenes } from './scenes';

/** One authored line, spoken in exactly one shot. */
export type SceneDialogueLine = {
  /** Speaker, spelled as the cast list spells it; empty = unattributed. */
  character: string;
  line: string;
  tone: string;
  /** The shot this line is spoken in. */
  shotId: string;
  /**
   * User-bound voice (#1559): unset = TTS when the speaker has a voice;
   * `DIALOGUE` = bind the conversation clip; `__video_model__` = the video
   * model invents the voice; any other string = an uploaded audio element.
   */
  voiceToken?: string;
};

const SCENE_DIALOGUE_SOURCES = ['prompt', 'user-edit'] as const;
export type SceneDialogueSource = (typeof SCENE_DIALOGUE_SOURCES)[number];

export const sceneDialogueVersions = snakeCase.table(
  'scene_dialogue_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sceneId: text()
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    lines: text({ mode: 'json' }).$type<SceneDialogueLine[]>().notNull(),
    source: text().$type<SceneDialogueSource>().notNull(),
    selectedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_scene_dialogue_versions_scene_created').on(
      table.sceneId,
      table.createdAt
    ),
    uniqueIndex('uq_scene_dialogue_versions_selected')
      .on(table.sceneId)
      .where(sql`${table.selectedAt} IS NOT NULL`),
  ]
);

export type SceneDialogueVersion = InferSelectModel<
  typeof sceneDialogueVersions
>;
