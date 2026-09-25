import { z } from 'zod';
import { aspectRatioSchema } from '@/models/aspect-ratios';
import { resolutionSchema } from '@/models/resolutions';
import { isValidAnalysisModelId } from '@/models/models.config';

/** Manual settings never imply a generation request. */
export const manualSequenceSettingsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  styleId: z.string().min(1),
  aspectRatio: aspectRatioSchema,
  resolution: resolutionSchema,
  analysisModel: z
    .string()
    .refine(isValidAnalysisModelId, 'Invalid text model'),
});

export const MANUAL_ANALYSIS_WORKFLOW = 'manual-analysis';
export const MANUAL_ANALYSIS_RETRY_MESSAGE =
  'Retry Determine shots or Scan for characters to keep your existing work.';
