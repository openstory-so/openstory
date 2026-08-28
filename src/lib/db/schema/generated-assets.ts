/**
 * Generated Assets — Direct Model Access (#458).
 *
 * Each row is ONE run of an arbitrary fal endpoint (picked from the live
 * modelschemas catalog), decoupled from the sequence→scene→shot→frame graph:
 * a flat, team-scoped asset. `input` snapshots exactly what the user submitted
 * (validated against the endpoint's live JSON Schema before the credit gate),
 * so a run can be inspected later without re-fetching the schema. `outputs`
 * are R2 uploads with origin-relative `/r2/<key>` URLs (#894). Catalog runs
 * (#458) still leave `costMicros` null. Studio runs (#1274) record the billed
 * still/clip cost after `deductWorkflowCredits`.
 *
 * FKs deliberately use `onDelete: 'restrict'` — never CASCADE — because
 * `teams` / `user` are long-lived parent tables (see the D1 table-rebuild
 * trap in CLAUDE.md).
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

/** A JSON-serializable value — no `unknown` escape hatch. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The user-submitted endpoint input, validated against the live schema. */
export type GeneratedAssetInput = Record<string, JsonValue>;

/** One uploaded output file; `url` is origin-relative R2 (`/r2/<key>`). */
export type GeneratedAssetOutput = {
  url: string;
  contentType: string;
};

/**
 * Media activities a generated-asset run can execute in v1. Mirrors the
 * modelschemas activity taxonomy restricted to fal media generation (chat /
 * embeddings / moderation don't produce storable assets).
 */
export const GENERATED_ASSET_ACTIVITIES = ['image', 'video', 'audio'] as const;
export type GeneratedAssetActivity =
  (typeof GENERATED_ASSET_ACTIVITIES)[number];

/**
 * Where the run was created. `catalog` is the flagged `/models` playground
 * (#458). `studio` is the Images and Videos surface (#1274) that uses the
 * same models as sequences.
 */
const GENERATED_ASSET_SOURCES = ['catalog', 'studio'] as const;
export type GeneratedAssetSource = (typeof GENERATED_ASSET_SOURCES)[number];

const GENERATED_ASSET_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;
type GeneratedAssetStatus = (typeof GENERATED_ASSET_STATUSES)[number];

export const generatedAssets = snakeCase.table(
  'generated_assets',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),

    // Which model ran. `endpointId` is the fal endpoint (e.g.
    // `fal-ai/flux-1/dev`); `modelName` is the catalog display name.
    provider: text({ length: 50 }).$type<'fal'>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    activity: text({ length: 20 }).$type<GeneratedAssetActivity>().notNull(),
    modelName: text({ length: 200 }).notNull(),
    source: text({ length: 20 })
      .$type<GeneratedAssetSource>()
      .default('catalog')
      .notNull(),
    isFavorite: integer({ mode: 'boolean' }).default(false).notNull(),

    input: text({ mode: 'json' }).$type<GeneratedAssetInput>().notNull(),

    // Generation tracking
    status: text().$type<GeneratedAssetStatus>().default('queued').notNull(),
    outputs: text({ mode: 'json' }).$type<GeneratedAssetOutput[]>(),
    error: text(),
    workflowRunId: text(),
    costMicros: integer(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Team-scoped newest-first listing: order by id (ULID ≈ creation time).
    index('idx_generated_assets_team').on(table.teamId, table.id),
    // Per-endpoint "recent runs" list on the model detail page.
    index('idx_generated_assets_team_endpoint').on(
      table.teamId,
      table.endpointId,
      table.id
    ),
    // Studio library: team + source (catalog vs studio) + recency.
    index('idx_generated_assets_team_source').on(
      table.teamId,
      table.source,
      table.id
    ),
  ]
);

export type GeneratedAsset = InferSelectModel<typeof generatedAssets>;
export type NewGeneratedAsset = InferInsertModel<typeof generatedAssets>;
