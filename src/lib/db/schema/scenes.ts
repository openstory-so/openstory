/**
 * Scenes Schema
 * Narrative units within a sequence — each owns an ordered list of shots.
 * A scene has no model of its own (#1066): the model that rendered an asset
 * is recorded on the version row that produced it.
 *
 * A scene is the render unit: capable models render all its shots in one
 * multi-shot call, others render N per-shot calls and attach the assets here.
 * Scene-level fields (location, time of day, story beat, continuity,
 * music design) live in dedicated columns or typed JSON so the shot's own
 * `metadata` no longer has to be the sole source of truth. The script is NOT
 * one of them — it lives in `scene_script_versions`, reached via
 * `selectedScriptVersionId`.
 *
 * @see src/lib/ai/scene-analysis.schema.ts for the Scene metadata structure
 * @see src/lib/db/schema/shots.ts — shots reference a scene via `shots.sceneId`
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

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
export type DbSceneId = string & { readonly __brand: 'DbSceneId' };

/**
 * Brand a raw ULID string as a `DbSceneId` (no conversion, just a type cast).
 * The single sanctioned place to mint the brand — mirrors `micros()` in
 * billing/money.ts.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor for DbSceneId
export const dbSceneId = (id: string): DbSceneId => id as DbSceneId;

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
    // Query/sort targets get dedicated columns (not buried in JSON).
    location: text(),
    timeOfDay: text(),
    storyBeat: text(),
    title: text(),
    // Typed JSON slices of the analysis Scene object.
    continuity: text({ mode: 'json' }).$type<SceneContinuity>(),

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
export type SceneRow = InferSelectModel<typeof scenes>;
export type NewScene = InferInsertModel<typeof scenes>;
