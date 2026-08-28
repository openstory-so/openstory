/**
 * Public request schema for `POST /api/v1/styles` — create a team-owned
 * library style from a complete v2 `StyleConfig`. Drizzle-free so
 * discovery/OpenAPI can import it. Server-managed columns (`isPublic`,
 * `isTemplate`, `sequenceId`, `usageCount`, `sortOrder`, `version`, …) are
 * absent here; the scoped-db layer strips them again.
 */

import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { StyleConfigSchema } from '@/lib/style/style-config';
import { z } from 'zod';

const tagList = z.array(z.string().trim().min(1).max(60)).max(20);

export const apiCreateStyleSchema = z.object({
  name: z.string().trim().min(1).max(255).meta({
    description:
      'Style name (unique per team — its URL slug must not collide with an existing library style).',
  }),
  description: z.string().trim().max(1000).optional(),
  category: z.string().trim().min(1).max(100).optional().meta({
    description:
      'Catalog category (film, commercial, ecommerce, influencer, animatic, animation, kids, tech).',
  }),
  tags: tagList.optional(),
  useCases: tagList.optional(),
  defaultAspectRatio: aspectRatioSchema.optional(),
  recommendedImageModel: z.string().trim().min(1).optional(),
  recommendedVideoModel: z.string().trim().min(1).optional(),
  config: StyleConfigSchema.meta({
    description:
      'The complete v2 style recipe (look + motion). v1 configs are not accepted.',
  }),
});

/** A representative `POST /api/v1/styles` body (also the OpenAPI example). */
export const EXAMPLE_CREATE_STYLE_BODY = {
  name: 'Rain-slick Neon Noir',
  category: 'film',
  tags: ['noir', 'neon'],
  config: {
    version: 2,
    look: {
      mood: 'tense, rain-soaked nocturne',
      artStyle: 'photorealistic live action',
      lighting: 'cyan and magenta neon practicals, wet reflections',
      colorPalette: ['#0a0a12', '#00e5ff', '#ff2bd6'],
      colorGrading: 'crushed blacks, teal-magenta split tone',
    },
    motion: { camera: 'handheld, close coverage', pace: 'measured', energy: 3 },
  },
} satisfies z.input<typeof apiCreateStyleSchema>;
