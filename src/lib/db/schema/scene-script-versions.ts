/**
 * Scene Script Versions Schema
 *
 * Version history of a scene's script slice (`extract` + `dialogue`). The
 * selected revision is pointed at by `scenes.selectedScriptVersionId`; scene
 * split seeds one `source: 'split'` row per scene and user edits append
 * `source: 'edit'` rows (#1030).
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning for the parallel prompt-version pattern.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { user } from './auth';
import { scenes } from './scenes';

const SCENE_SCRIPT_SOURCES = ['split', 'edit'] as const;
export type SceneScriptSource = (typeof SCENE_SCRIPT_SOURCES)[number];

type SceneScriptContent = Scene['originalScript'];

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
