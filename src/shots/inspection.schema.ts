import { z } from 'zod';
import { originalScriptSchema } from './scene-analysis.schema';

const assetSchema = z.object({
  versionId: z.string().nullable(),
  usable: z.boolean(),
  url: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
const attemptSchema = z.object({
  status: z.enum(['pending', 'generating', 'completed', 'failed', 'cancelled']),
  error: z.string().nullable(),
});
export const shotInspectionSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  sceneId: z.string().nullable(),
  shotNumber: z.number().nullable(),
  durationMs: z.number().nullable(),
  useStartFrame: z.boolean().nullable(),
  effectiveUseStartFrame: z.boolean(),
  renderSegmentId: z.string().nullable(),
  anchorFrame: z
    .object({
      id: z.string(),
      ...attemptSchema.shape,
      selectedImage: assetSchema,
      selectedPromptVersionId: z.string().nullable(),
      prompt: z.string().nullable().optional(),
      previewUrl: z.string().nullable().optional(),
    })
    .nullable(),
  motion: z.object({
    ...attemptSchema.shape,
    selectedVideo: assetSchema,
    selectedPromptVersionId: z.string().nullable(),
    prompt: z.string().nullable().optional(),
  }),
});
export const sceneInspectionSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  orderIndex: z.number(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  timeOfDay: z.string().nullable(),
  storyBeat: z.string().nullable(),
  selectedScriptVersionId: z.string().nullable(),
  shots: z.array(shotInspectionSchema),
  shotsTruncated: z
    .boolean()
    .describe('Use list_shots with this sceneId to page the remaining shots.'),
});
export const sceneDetailSchema = sceneInspectionSchema.extend({
  script: z
    .object({
      id: z.string(),
      source: z.enum(['split', 'edit']),
      content: originalScriptSchema,
    })
    .nullable(),
  continuity: z.record(z.string(), z.unknown()).nullable(),
  defaultModels: z.object({ image: z.string(), video: z.string() }),
});
