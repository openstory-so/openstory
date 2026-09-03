import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import {
  AUDIO_MODELS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  referenceOnlyCapableWith,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  isValidAnalysisModelId,
} from '@/lib/ai/models.config';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { resolutionSchema } from '@/lib/constants/resolutions';
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

export const MUSIC_REQUIRES_MOTION_ERROR =
  'Music generation currently requires motion. Turn on motion or disable music.';

export const REFERENCE_ONLY_MODEL_ERROR =
  'Without start frames, the video model must render from references alone. Pick Seedance, H3 Max, Omni Flash or Grok Imagine, or turn on Generate start frames.';

export const REFERENCE_ONLY_REQUIRES_MOTION_ERROR =
  'Without start frames, each shot renders straight to video, so motion is required. Turn motion on, or turn on Generate start frames.';

export const createSequenceSchema = createInsertSchema(sequences, {
  title: (schema) => schema.min(1).optional(), // Optional - defaults to 'Untitled Sequence' in hook
  script: z.string().min(10), // Override to make it required with business rules
  teamId: ulidSchemaOptional, // Optional - will use user's default team if not provided
  aspectRatio: aspectRatioSchema.optional(), // Optional - defaults to '16:9' in database
  resolution: resolutionSchema.optional(), // Optional - defaults to '720p' in database
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
    // Copied from the style row on create — clients send styleId only.
    styleConfig: true,
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
    // Product default ON for the aha path (stills + motion + music). Callers
    // that omit flags get true after parse — keep API v1 explicit if it must
    // stay opt-in spend. Zod `.default()` runs before handler destructuring, so
    // handler `= true` alone is not enough when the flag is omitted.
    autoGenerateMotion: z.boolean().default(true).optional(),
    autoGenerateMusic: z.boolean().default(true).optional(),
    // Explicit default for the same reason as the flags above: the model
    // refinement below and the create handler both read the parsed value, and
    // leaving it `undefined` would make "off" indistinguishable from "unset".
    generateStartFrames: z.boolean().default(false).optional(),
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
    // Enhance / Generate duration chip (15 / 30 / 60 / 120 / 180 / 300). Pre-flight scene
    // count + per-shot duration use this so client ActionCost and server
    // requireCredits stay aligned before Scene N headings exist (#1140).
    targetDurationSeconds: z.number().min(5).max(300).optional(),
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
          tempPublicUrl: mediaUrlSchema,
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
  })
  .refine((data) => !data.autoGenerateMusic || data.autoGenerateMotion, {
    path: ['autoGenerateMusic'],
    message: MUSIC_REQUIRES_MOTION_ERROR,
  })
  // Reference-only has no start frame, so EVERY selected model must have a
  // route whose start frame is optional — not just the primary. A variant
  // model without one would fail every shot it was asked to render.
  //
  // This schema is isomorphic and pure, so it cannot know which vias a team
  // reaches. It asks the widest question — capable on SOME via — which rejects
  // Kling / Veo / LTX always and lets Grok Imagine through; `createSequences`
  // then re-asks it against the team's real keys via `canRenderReferenceOnly`.
  .refine(
    (data) =>
      data.generateStartFrames ||
      data.videoModels.every(
        (model) =>
          validVideoModelKeys.includes(model) &&
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded by the key check above
          referenceOnlyCapableWith(model as ImageToVideoModel, { xai: true })
      ),
    {
      path: ['generateStartFrames'],
      message: REFERENCE_ONLY_MODEL_ERROR,
    }
  )
  // Reference-only skips the image pass; motion is the only thing left that
  // renders. With motion off the sequence would complete having generated
  // nothing at all, and report success doing it.
  .refine((data) => data.generateStartFrames || data.autoGenerateMotion, {
    path: ['generateStartFrames'],
    message: REFERENCE_ONLY_REQUIRES_MOTION_ERROR,
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
  resolution: resolutionSchema.optional(),
}).omit({
  id: true,
  teamId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  workflow: true, // Set by workflow, not user
  workflowRunId: true, // Set at workflow trigger time, not user
  // Set at creation only. Toggling it on an existing sequence bypasses the
  // model refine below AND rewrites what every already-rendered shot means:
  // on, the stills the user approved are silently dropped from the request
  // while their prompts still assume one; off, no shot has a still and batch
  // motion finds nothing eligible. Regenerate instead of toggling.
  generateStartFrames: true,
  // Copied from the style row on styleId change — clients send styleId only.
  styleConfig: true,
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
