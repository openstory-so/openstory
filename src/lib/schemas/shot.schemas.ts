import { z } from 'zod';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { shots } from '@/lib/db/schema/shots';
import { IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';

/**
 * Shared Zod schemas for shot operations
 * Generated from Drizzle schema with custom refinements
 */

const createShotSchema = createInsertSchema(shots, {
  // Optional on create: the column has a DB default (3000ms), and manual shot
  // creation (#1108) sends only sceneId — the refinement alone made the key
  // required, forcing every caller to restate the default.
  durationMs: (schema) => schema.min(1).optional(),
}).omit({
  id: true,
  // Soft-delete is owned by the dedicated delete/restore fns, never an input.
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
});

export const updateShotSchema = createUpdateSchema(shots, {
  durationMs: (schema) => schema.min(1),
})
  .omit({
    id: true,
    sequenceId: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  // Neither prompt is a `shots` column any more — the image prompt lives on the
  // anchor frame (#989) and the motion prompt on its selected version (#713).
  // Accept both here as explicit fields; `updateShotFn` routes them to
  // `frame_prompt_versions` / `shot_prompt_versions` rather than the shots
  // UPDATE.
  .extend({
    imagePrompt: z.string().nullable().optional(),
    motionPrompt: z.string().nullable().optional(),
  });

export const regenerateShotSchema = z.object({
  regenerateDescription: z.boolean().optional(),
  regenerateThumbnail: z.boolean().optional(),
  model: z
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
    .enum(Object.keys(IMAGE_MODELS) as [keyof typeof IMAGE_MODELS])
    .optional(),
  prompt: z.string().optional(),
});

export const generateMotionSchema = z.object({
  model: z
    .enum(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
      Object.keys(IMAGE_TO_VIDEO_MODELS) as [keyof typeof IMAGE_TO_VIDEO_MODELS]
    )
    .optional(),
  prompt: z.string().optional(),
  duration: z.number().min(1).max(10).optional(),
  fps: z.number().min(7).max(30).optional(),
  motionBucket: z.number().min(1).max(255).optional(),
  /** Toggle sfx/dialogue/ambient audio for audio-capable models. */
  generateAudio: z.boolean().optional(),
});

export const generateVariantSchema = z.object({
  model: z
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
    .enum(Object.keys(IMAGE_MODELS) as [keyof typeof IMAGE_MODELS])
    .optional(),
  imageSize: z
    .enum(['square_hd', 'portrait_16_9', 'landscape_16_9'])
    .optional(),
  numImages: z.number().min(1).max(4).optional(),
  seed: z.number().int().optional(),
});

// Schemas for API endpoint shot creation (sequenceId comes from URL params)
export const singleShotSchema = createShotSchema.omit({ sequenceId: true });

export const bulkShotSchema = z.object({
  shots: z.array(createShotSchema.omit({ sequenceId: true })).min(1),
});

export type GenerateVariantInput = z.infer<typeof generateVariantSchema>;
