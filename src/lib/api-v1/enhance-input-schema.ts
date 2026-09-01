/**
 * Public input schema for `POST /api/v1/scripts/enhance`. Like
 * {@link apiCreateSequenceSchema} this is deliberately ergonomic — callers pass
 * a style by id/name/slug and reference elements by hosted URL — and carries
 * `.meta({...})` on every field so `z.toJSONSchema()` yields a fully-described
 * OpenAPI component.
 *
 * Scope is intentionally limited to the inputs that actually influence the
 * enhancement output today: style (→ its StyleConfig), aspect ratio, target
 * duration, video model (clip-grid constraint for scene labels), and reference
 * elements. Cast/locations don't feed the enhance prompt yet, so they're not
 * accepted here (vs. the create endpoint, which uses them for generation).
 *
 * This module is client-safe (zod only) so the discovery/OpenAPI documents can
 * import it without pulling in the server-only AI stack from `enhance.ts`.
 */

import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { z } from 'zod';

export const apiEnhanceScriptSchema = z
  .object({
    script: z
      .string()
      .min(10)
      .max(50000)
      .meta({
        description:
          'Raw script or a one-liner / brief to expand into a full visual script.',
        examples: ['A lighthouse keeper befriends a stranded whale.'],
      }),

    style: z
      .string()
      .min(1)
      .optional()
      .meta({
        description:
          "Style by id, name, or slugified name. When given, the style's aesthetics (mood, lighting, palette, camera work, reference films) guide the enhancement. Omit for a neutral enhancement.",
        examples: ['Cinematic Noir'],
      }),
    aspectRatio: aspectRatioSchema.optional().meta({
      description:
        "Aspect ratio framing hint. Defaults to the resolved style's recommendation when omitted.",
    }),
    targetSeconds: z
      .int()
      .min(5)
      .max(300)
      .optional()
      .meta({
        description:
          'Target video length in seconds (max 5 minutes); guides scene count and length of the enhanced script.',
        examples: [30],
      }),
    videoModel: z
      .string()
      .min(1)
      .optional()
      .meta({
        description:
          "Video (image-to-video) model catalog key. Scene duration labels are constrained to this model's clip grid (e.g. 6, 8 or 10 seconds for ltx_2_3_pro). Defaults to the platform default.",
        examples: ['ltx_2_3_pro'],
      }),

    elements: z
      .array(
        z
          .object({
            url: z.url().meta({
              description:
                'Hosted image URL for the element; sent to the model so it can see the reference.',
            }),
            token: z
              .string()
              .min(1)
              .max(100)
              .meta({
                description:
                  'UPPERCASE token used to reference this element in the enhanced script.',
                examples: ['LOGO'],
              }),
            description: z
              .string()
              .max(2000)
              .optional()
              .meta({ description: 'Optional description of the element.' }),
          })
          .meta({ id: 'EnhanceElementInput' })
      )
      .optional()
      .meta({
        description:
          'Reference elements (logos, products) to weave into the script by token.',
      }),
  })
  .meta({
    id: 'EnhanceScriptRequest',
    title: 'Enhance Script Request',
    description:
      'Input for POST /api/v1/scripts/enhance — enhance a script without creating a sequence. Streams the enhanced script back as Server-Sent Events.',
  });

export type ApiEnhanceScriptInput = z.infer<typeof apiEnhanceScriptSchema>;
