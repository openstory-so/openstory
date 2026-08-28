/**
 * Library Resources Schema
 * Styles, characters, VFX, and audio assets for teams
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import z from 'zod';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

// Canonical config schema lives drizzle-free in src/lib/style/style-config.ts;
// re-exported here to keep the historical `@/lib/db/schema` import paths.
import type { StoredStyleConfig } from '@/lib/style/style-config';
export {
  StyleConfigSchema,
  type StyleConfig,
  type StoredStyleConfig,
} from '@/lib/style/style-config';

const StyleSampleVideoKindSchema = z.enum(['canonical', 'category', 'bespoke']);

export const StyleSampleVideoSchema = z.object({
  url: mediaUrlSchema,
  kind: StyleSampleVideoKindSchema,
  label: z.string(),
  durationSeconds: z.number().nonnegative(),
  order: z.number().int().nonnegative(),
});
export type StyleSampleVideo = z.infer<typeof StyleSampleVideoSchema>;

/**
 * Styles library
 * Style Stacks - JSON configurations for consistent AI-generated content
 */
export const styles = snakeCase.table(
  'styles',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    // Set on an automatic style (#1213): derived from one sequence's script,
    // visible only through that sequence, excluded from every library list and
    // the slug-uniqueness check. Cleared by promotion. No FK: `sequences`
    // already references `styles`, and the row is inserted before its
    // sequence exists. `sequences.delete` removes it; re-styling a sequence
    // leaves it orphaned (unreachable, harmless).
    sequenceId: text(),
    name: text({ length: 255 }).notNull(),
    description: text(),
    // StoredStyleConfig (v1 | v2) until the backfill lands (#858): typing the
    // column as parsed v2 would compile direct `.look` access that crashes on
    // legacy rows. Read through `parseStyleConfig` / `toStyleProjection`.
    config: text({ mode: 'json' }).$type<StoredStyleConfig>().notNull(),
    category: text({ length: 100 }),
    // SQLite doesn't have array type - store as JSON array
    tags: text({ mode: 'json' })
      .$type<string[]>()
      .$defaultFn(() => []),
    isPublic: integer({ mode: 'boolean' }).default(false),
    isTemplate: integer({ mode: 'boolean' }).default(false),
    version: integer().default(1),
    previewUrl: text(),
    sampleVideos: text({ mode: 'json' })
      .$type<StyleSampleVideo[]>()
      .$defaultFn(() => []),
    recommendedImageModel: text(),
    recommendedVideoModel: text(),
    defaultAspectRatio: text(),
    useCases: text({ mode: 'json' })
      .$type<string[]>()
      .$defaultFn(() => []),
    sortOrder: integer().default(100),
    usageCount: integer().default(0),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_styles_team_id').on(table.teamId),
    index('idx_styles_sequence_id').on(table.sequenceId),
  ]
);

/**
 * VFX library
 * Visual effects presets and configurations
 */
export const vfx = snakeCase.table(
  'vfx',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    presetConfig: text({ mode: 'json' }).default('{}').notNull(),
    previewUrl: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_vfx_name').on(table.name),
    index('idx_vfx_team_id').on(table.teamId),
  ]
);

/**
 * Audio library
 * Sound effects and music tracks
 */
export const audio = snakeCase.table(
  'audio',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    fileUrl: text().notNull(),
    durationMs: integer(),
    metadata: text({ mode: 'json' }).default('{}'),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_audio_name').on(table.name),
    index('idx_audio_team_id').on(table.teamId),
  ]
);

// Type exports
export type Style = InferSelectModel<typeof styles>;
export type NewStyle = InferInsertModel<typeof styles>;

export type Vfx = InferSelectModel<typeof vfx>;

export type Audio = InferSelectModel<typeof audio>;
