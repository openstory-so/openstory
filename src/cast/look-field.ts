import { z } from 'zod';

/**
 * The fields a person writes on a look (#2015). Blank clothing or styling
 * clears it; the name is never blank.
 */
export const LOOK_TEXT_MAX = 5000;

export const lookFieldsSchema = z.object({
  name: z.string().trim().min(1).max(255),
  clothing: z.string().trim().max(LOOK_TEXT_MAX).nullable(),
  styling: z.string().trim().max(LOOK_TEXT_MAX).nullable(),
});
