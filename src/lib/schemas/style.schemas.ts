import {
  StyleConfigSchema,
  styles,
  StyleSampleVideoSchema,
} from '@/lib/db/schema';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for style operations
 */

// Create defaults absent lists to [] so rows never carry null lists; update
// keeps them optional (PATCH semantics) but never null.
const tagsCreateSchema = z.array(z.string()).default([]);
const useCasesCreateSchema = z.array(z.string()).default([]);
const tagsUpdateSchema = z.array(z.string()).optional();
const useCasesUpdateSchema = z.array(z.string()).optional();
const sampleVideosSchema = z.array(StyleSampleVideoSchema).nullish();

// Columns the client must never set. usageCount is server-managed (popularity
// ranking), id/teamId/createdBy/createdAt/updatedAt are injected by the scoped
// layer, and public/template flags, version, and sortOrder are
// admin/migration-only.
// Exported so the scoped-db write methods can exclude the same columns at
// the type level AND scrub them at runtime — a column added here is enforced
// in all three places at once.
export const SERVER_MANAGED_STYLE_COLUMNS = {
  id: true,
  teamId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  usageCount: true,
  version: true,
  isPublic: true,
  isTemplate: true,
  sortOrder: true,
  // Sequence binding is set by sequence creation and cleared by promotion.
  sequenceId: true,
} as const;

export type ServerManagedStyleColumn =
  keyof typeof SERVER_MANAGED_STYLE_COLUMNS;

export const createStyleSchema = createInsertSchema(styles, {
  // New writes are always v2; stored v1 rows are read-tolerated, not written.
  config: () => StyleConfigSchema,
  tags: () => tagsCreateSchema,
  useCases: () => useCasesCreateSchema,
  sampleVideos: () => sampleVideosSchema,
})
  .omit(SERVER_MANAGED_STYLE_COLUMNS)
  // Category drives recommendation briefs and library grouping — required on
  // create (the DB column is nullable only for legacy rows). `.extend` because
  // drizzle-zod keeps nullable columns optional even with a refinement.
  .extend({ category: z.string().min(1) });
// Config is whole-or-omitted on update: the aesthetic recipe is one atomic
// value — partial patches could not maintain cross-field coherence.
export const updateStyleSchema = createUpdateSchema(styles, {
  config: () => StyleConfigSchema.optional(),
  category: () => z.string().min(1).optional(),
  tags: () => tagsUpdateSchema,
  useCases: () => useCasesUpdateSchema,
  sampleVideos: () => sampleVideosSchema,
}).omit(SERVER_MANAGED_STYLE_COLUMNS);
