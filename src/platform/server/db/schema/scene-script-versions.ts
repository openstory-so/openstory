/**
 * Scene Script Versions Schema
 *
 * Version history of a scene: its script slice (`extract` + `dialogue`) and,
 * since #1600, its narrative (title, heading, time of day, story beat,
 * continuity tags). The selected revision is pointed at by
 * `scenes.selectedScriptVersionId`; scene split seeds one `source: 'split'`
 * row per scene and user edits append `source: 'edit'` rows (#1030).
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning for the parallel prompt-version pattern.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { scenes } from './scenes';

// `renamed`: an element-token rename's rewrite of the selected row (#1786).
// `backfill`: the #1600 migration's first row for a scene that had none (a
// scene added by hand before #1600).
const SCENE_SCRIPT_SOURCES = ['split', 'edit', 'renamed', 'backfill'] as const;
export type SceneScriptSource = (typeof SCENE_SCRIPT_SOURCES)[number];

type SceneScriptContent = Scene['originalScript'];
type SceneContinuity = NonNullable<Scene['continuity']>;

export const sceneScriptVersions = snakeCase.table(
  'scene_script_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sceneId: text()
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    content: text({ mode: 'json' }).$type<SceneScriptContent>().notNull(),
    // The scene's narrative at this version (#1600). Nullable: each is
    // optional on a scene (a hand-added scene may have none of them).
    title: text(),
    location: text(),
    timeOfDay: text(),
    storyBeat: text(),
    continuity: text({ mode: 'json' }).$type<SceneContinuity>(),
    // Whether this row carries the narrative (#1600). Every row written since
    // does (the $defaultFn); the backfill marks the rows it filled. A row a
    // pre-#1600 worker wrote during the deploy window is false, and reads fall
    // back to the scene's legacy columns for it.
    hasNarrative: integer({ mode: 'boolean' })
      .default(false)
      .$defaultFn(() => true)
      .notNull(),
    source: text().$type<SceneScriptSource>().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_scene_script_versions_scene_created').on(
      table.sceneId,
      table.createdAt
    ),
  ]
);

export type SceneScriptVersion = InferSelectModel<typeof sceneScriptVersions>;

/** The narrative fields a scene version carries, in display order. */
export const SCENE_NARRATIVE_FIELDS = [
  'title',
  'location',
  'timeOfDay',
  'storyBeat',
  'continuity',
] as const satisfies readonly (keyof SceneScriptVersion)[];

export type SceneNarrative = Pick<
  SceneScriptVersion,
  (typeof SCENE_NARRATIVE_FIELDS)[number]
>;
