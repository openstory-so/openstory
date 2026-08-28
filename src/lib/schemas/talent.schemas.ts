import { uploadAttestationSchema } from '@/lib/compliance/likeness-upload';
import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { characterBibleEntrySchema } from '@/lib/ai/scene-analysis.schema';
import { talent, talentSheets } from '@/lib/db/schema';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for talent library operations
 */

// Columns the client must never set. id/teamId/createdBy/createdAt/updatedAt
// are injected by the scoped layer, and the public/template flags are
// admin/seeder-only — a client-settable isPublic would let a team publish its
// own talent into the anonymous public catalogue (same class as #869).
// Exported so the scoped-db write methods can exclude the same columns at
// the type level AND scrub them at runtime — a column added here is enforced
// in all three places at once.
export const SERVER_MANAGED_TALENT_COLUMNS = {
  id: true,
  teamId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  isPublic: true,
  isTemplate: true,
} as const;

export type ServerManagedTalentColumn =
  keyof typeof SERVER_MANAGED_TALENT_COLUMNS;

// Talent schemas
export const createTalentSchema = createInsertSchema(talent, {
  name: z.string().min(1).max(255),
  description: z.string().optional(),
})
  .omit(SERVER_MANAGED_TALENT_COLUMNS)
  .extend({
    referenceImageUrls: z.array(mediaUrlSchema).optional(),
    /**
     * Subset of `referenceImageUrls` that the client classified as an
     * existing character/talent sheet. Omitted means the server classifies.
     * Pass `[]` when none of the uploads are sheets.
     */
    characterSheetImageUrls: z.array(mediaUrlSchema).optional(),
    /**
     * Required by the server when `referenceImageUrls` is non-empty.
     * Portrait statement + basis when `isHuman`; asset statement otherwise.
     */
    portraitAttestation: uploadAttestationSchema.optional(),
  });

export const updateTalentSchema = createUpdateSchema(talent).omit(
  SERVER_MANAGED_TALENT_COLUMNS
);

// Talent sheet schemas
export const createTalentSheetSchema = createInsertSchema(talentSheets, {
  name: z.string().min(1).max(255),
  metadata: () => characterBibleEntrySchema.nullish(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Filter schemas
export const listTalentFilterSchema = z.object({
  favoritesOnly: z.boolean().optional(),
});

export type CreateTalentInput = z.infer<typeof createTalentSchema>;
export type UpdateTalentInput = z.infer<typeof updateTalentSchema>;
