/**
 * Scenes Schema
 * Narrative units within a sequence — each owns an ordered list of shots.
 * A scene has no model of its own (#1066): the model that rendered an asset
 * is recorded on the version row that produced it.
 *
 * A scene is the render unit: capable models render all its shots in one
 * multi-shot call, others render N per-shot calls and attach the assets here.
 * Scene-level fields (location, time of day, story beat, continuity,
 * music design) used to be columns edited in place. Since #1600 they live on
 * the selected `scene_script_versions` row with the script, reached via
 * `selectedScriptVersionId`, so every edit is a version.
 *
 * @see src/shots/scene-analysis.schema.ts for the Scene metadata structure
 * @see src/platform/server/db/schema/shots.ts — shots reference a scene via `shots.sceneId`
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { sequences } from './sequences';
import type { SceneNarrative } from './scene-script-versions';

/**
 * Branded id for `scenes.id` (a ULID). Distinct from the server-minted
 * analysis `Scene.sceneId` carried in scene-split output (see `analysisSceneId`
 * in the ShotMapping type) — both are plain strings, so this brand exists for call
 * sites that want the compiler to keep the two apart. The `scenes.id` column is
 * `.$type<DbSceneId>()`, so `SceneRow.id` — and any relation query that reaches
 * a scene — carries the brand by inference. The scoped scene methods take it for
 * their id params, so a `scene.id` flows through naturally, while a bare
 * analysis `sceneId` string won't type-check where a `DbSceneId` is expected.
 */
import type { DbSceneId } from '@/shots/scene-id';
export type { DbSceneId };

// Scene-level slices of the analysis `Scene` object, reused verbatim so the
// JSON columns stay precisely typed without re-declaring the shapes. Both
// columns are nullable (the backfill writes NULL for a null-metadata shot).
type SceneContinuity = NonNullable<Scene['continuity']>;

/**
 * Scenes table — narrative units within a sequence.
 */
export const scenes = snakeCase.table(
  'scenes',
  {
    id: text()
      .$defaultFn(() => generateId())
      .$type<DbSceneId>()
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // 0-based scene order within the sequence.
    orderIndex: integer().notNull(),
    // LEGACY narrative columns (#1600). The narrative lives on the selected
    // `scene_script_versions` row; these are read only as the fallback for a
    // scene with no script version (`scoped/scenes.ts`) and never written.
    // The `legacy` names keep the SQL columns but make every raw reader a
    // compile error. Drop them after a second backfill in a later deploy.
    legacyLocation: text('location'),
    legacyTimeOfDay: text('time_of_day'),
    legacyStoryBeat: text('story_beat'),
    legacyTitle: text('title'),
    legacyContinuity: text('continuity', {
      mode: 'json',
    }).$type<SceneContinuity>(),

    // The scene's script: the pointer to the selected row in
    // `scene_script_versions` (#1030) IS the script — there is no column copy.
    // Plain text id (no FK) to avoid a circular schema dependency.
    selectedScriptVersionId: text(),

    // NOTE: a scene deliberately has NO model columns (#1066). Model identity
    // belongs to the row that recorded the generation — `frame_variants.model`
    // for a still, `video_variants.model` for a clip — not to a narrative unit.
    // Resolution reads the selected version; see @/lib/ai/resolve-asset-models.
    // It also owns no video columns (#1067): a scene's render is tiled into
    // `render_segments` (#990), and each segment points at its `video_variants`.
    // Soft-delete (#1108 Phase 1, undoable). Cascades softly to the scene's
    // shots (same timestamp — restore uses the equality to bring back exactly
    // the children this delete hid). `orderIndex` keeps its slot; reorder
    // renumbers deleted rows into the tail band.
    deletedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_scenes_sequence_order').on(table.sequenceId, table.orderIndex),
    uniqueIndex('scenes_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

// `id` carries the `DbSceneId` brand via the column's `.$type<>()`, so the
// inferred models are branded directly — no Omit-and-re-add, and relation
// queries / the `shots.sceneId` FK pick the brand up for free.
/** The stored row, legacy narrative included (scoped module only). */
export type SceneRecord = InferSelectModel<typeof scenes>;

/** The legacy narrative columns (#1600) — never read outside the resolver. */
export type LegacySceneNarrativeColumn =
  | 'legacyLocation'
  | 'legacyTimeOfDay'
  | 'legacyStoryBeat'
  | 'legacyTitle'
  | 'legacyContinuity';

/**
 * A scene with its narrative resolved from the selected script version
 * (#1600). What every scoped read returns.
 */
export type SceneRow = Omit<SceneRecord, LegacySceneNarrativeColumn> &
  SceneNarrative;

/** A new scene row. Its narrative is written as its first script version. */
export type NewScene = Omit<
  InferInsertModel<typeof scenes>,
  LegacySceneNarrativeColumn
>;
