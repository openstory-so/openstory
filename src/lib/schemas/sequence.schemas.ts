import {
  AUDIO_MODELS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  isValidAnalysisModelId,
} from '@/lib/ai/models.config';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { sequences } from '@/lib/db/schema/sequences';
import { ulidSchemaOptional } from '@/lib/schemas/id.schemas';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for sequence operations
 * Generated from Drizzle schema with custom refinements
 */

// Get valid model IDs for validation
const validImageModelKeys = Object.keys(
  IMAGE_MODELS
) satisfies readonly string[];
const validVideoModelKeys = Object.keys(
  IMAGE_TO_VIDEO_MODELS
) satisfies readonly string[];
const validAudioModelKeys = Object.keys(
  AUDIO_MODELS
) satisfies readonly string[];

export const createSequenceSchema = createInsertSchema(sequences, {
  title: (schema) => schema.min(1).optional(), // Optional - defaults to 'Untitled Sequence' in hook
  script: z.string().min(10), // Override to make it required with business rules
  teamId: ulidSchemaOptional, // Optional - will use user's default team if not provided
  aspectRatio: aspectRatioSchema.optional(), // Optional - defaults to '16:9' in database
  styleId: z.string().optional(), // Optional - can be null
})
  .omit({
    id: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    createdBy: true,
    updatedBy: true,
    analysisModel: true, // Omit singular model - we'll use analysisModels array
    imageModel: true, // Omit - will use imageModel field in extend
    videoModel: true, // Omit - will use videoModel field in extend
    workflow: true, // Omit - set by workflow, not user
    // Music fields - managed by workflow, not user input
    musicUrl: true,
    musicPath: true,
    musicStatus: true,
    musicGeneratedAt: true,
    musicError: true,
    musicModel: true,
    musicPrompt: true,
    musicTags: true,
  })
  .extend({
    // Accept array of models for multi-model sequence creation
    analysisModels: z
      .array(
        z.string().refine(isValidAnalysisModelId, {
          message: 'Invalid analysis model',
        })
      )
      .min(1, 'At least one model must be selected')
      .default([DEFAULT_ANALYSIS_MODEL]),
    // Primary image model (model key, not full ID) — first of imageModels
    imageModel: z
      .string()
      .refine((val) => validImageModelKeys.includes(val), {
        message: 'Invalid image model',
      })
      .default(DEFAULT_IMAGE_MODEL)
      .optional(),
    // Multiple image models for variant generation (first is primary)
    imageModels: z
      .array(
        z.string().refine((val) => validImageModelKeys.includes(val), {
          message: 'Invalid image model',
        })
      )
      .min(1, 'At least one image model must be selected')
      .default([DEFAULT_IMAGE_MODEL]),
    // Video model selection (model key, not full ID) — primary / first of videoModels
    videoModel: z
      .string()
      .refine((val) => validVideoModelKeys.includes(val), {
        message: 'Invalid video model',
      })
      .default(DEFAULT_VIDEO_MODEL),
    // Multiple video models for variant generation (first is primary)
    videoModels: z
      .array(
        z.string().refine((val) => validVideoModelKeys.includes(val), {
          message: 'Invalid video model',
        })
      )
      .min(1, 'At least one video model must be selected')
      .default([DEFAULT_VIDEO_MODEL]),
    // Auto-generate motion flag (UI-only, not stored in DB)
    autoGenerateMotion: z.boolean().default(false).optional(),
    // Auto-generate music flag (UI-only, not stored in DB)
    autoGenerateMusic: z.boolean().default(false).optional(),
    // Music model selection (model key, not full ID) — primary / first of audioModels
    musicModel: z
      .string()
      .refine((val) => validAudioModelKeys.includes(val), {
        message: 'Invalid music model',
      })
      .optional(),
    // Multiple audio models for variant generation (first is primary). Optional
    // (music is opt-in via autoGenerateMusic); when present must be non-empty.
    audioModels: z
      .array(
        z.string().refine((val) => validAudioModelKeys.includes(val), {
          message: 'Invalid audio model',
        })
      )
      .min(1, 'At least one audio model must be selected')
      .optional(),
    // Suggested talent IDs for AI-assisted casting during generation
    suggestedTalentIds: z.array(z.string()).optional(),
    // Suggested location IDs for visual consistency during generation
    suggestedLocationIds: z.array(z.string()).optional(),
    // Draft element uploads (presigned to temp path before sequence exists).
    // description/consistencyTag are populated by the inline analyzeDraftElementFn
    // call so promoteTempElements can write them straight onto the new row
    // instead of re-triggering the async vision workflow.
    elementUploads: z
      .array(
        z.object({
          tempPath: z.string().min(1),
          tempPublicUrl: z.string().url(),
          filename: z.string().min(1),
          token: z.string().min(1).max(100),
          description: z.string().nullable().optional(),
          consistencyTag: z.string().nullable().optional(),
        })
      )
      .optional(),
    // When regenerating from an existing sequence, copy its elements onto the
    // newly created sequence so the user doesn't have to re-upload references.
    sourceSequenceId: ulidSchemaOptional,
  });

export const updateSequenceSchema = createUpdateSchema(sequences, {
  title: (schema) => schema.min(1), // drizzle-zod auto-applies max from varchar(500)
  script: (schema) => schema.min(10).max(10000), // Business rule: meaningful scripts
  analysisModel: (schema) =>
    schema.refine(isValidAnalysisModelId, {
      message: 'Invalid analysis model',
    }),
  imageModel: (schema) =>
    schema.refine((val) => validImageModelKeys.includes(val), {
      message: 'Invalid image model',
    }),
  videoModel: (schema) =>
    schema.refine((val) => validVideoModelKeys.includes(val), {
      message: 'Invalid video model',
    }),
  aspectRatio: aspectRatioSchema.optional(),
}).omit({
  id: true,
  teamId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  workflow: true, // Set by workflow, not user
  // Music fields - managed by workflow, not user input
  musicUrl: true,
  musicPath: true,
  musicStatus: true,
  musicGeneratedAt: true,
  musicError: true,
  musicModel: true,
  musicPrompt: true,
  musicTags: true,
});

export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;
