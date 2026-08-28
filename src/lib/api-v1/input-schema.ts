/**
 * Public input schema for `POST /api/v1/sequences`. Deliberately ergonomic and
 * lenient: callers pass human-friendly references (style by id or name, cast and
 * locations by id/name or an inline create object). The orchestrator resolves
 * these into the strict `CreateSequenceInput`, which re-validates model keys
 * etc. — so this schema only needs to police shape, not model validity.
 *
 * Every field carries `.meta({...})` so `z.toJSONSchema(apiCreateSequenceSchema)`
 * yields a fully-described OpenAPI component (titles/descriptions/examples)
 * without hand-writing the spec. Uses Zod 4 top-level formats (`z.url`, `z.int`).
 */

import { portraitAttestationSchema } from '@/lib/compliance/likeness-upload';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { MUSIC_REQUIRES_MOTION_ERROR } from '@/lib/schemas/sequence.schemas';
import { z } from 'zod';

const entityName = z
  .string()
  .min(1)
  .max(255)
  .meta({ description: 'Display name.' });
const entityDescription = z
  .string()
  .max(2000)
  .optional()
  .meta({ description: 'Optional description used to guide generation.' });
const referenceImageUrls = z.array(z.url()).optional().meta({
  description:
    'Optional hosted reference image URLs; ingested and used to generate the reference sheet.',
});

/** Inline request to create a new library cast member (talent). */
const createCharacterSchema = z
  .object({
    name: entityName,
    description: entityDescription,
    isHuman: z.boolean().optional().meta({
      description: 'Whether the character is a human (vs creature/object).',
    }),
    referenceImageUrls,
    portraitAttestation: portraitAttestationSchema.optional().meta({
      description:
        'Required when referenceImageUrls is set: portrait-rights statement version and authorization basis.',
    }),
  })
  .superRefine((value, ctx) => {
    if (
      value.referenceImageUrls?.length &&
      !value.portraitAttestation?.authorizationBasis.trim()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['portraitAttestation'],
        message:
          'portraitAttestation is required when uploading reference images of a person.',
      });
    }
  })
  .meta({ id: 'CreateCharacter' });

/** Inline request to create a new library location. */
const createLocationSchema = z
  .object({
    name: entityName,
    description: entityDescription,
    referenceImageUrls,
  })
  .meta({ id: 'CreateLocation' });

/**
 * One cast member / location: a **reference** to an existing library entry
 * (string = id or name), or an inline **create** request (object). A single
 * list per kind keeps the "some exist, some are new" mental model.
 */
const characterRefSchema = z
  .union([z.string().min(1), createCharacterSchema])
  .meta({
    id: 'CharacterRef',
    description:
      'Existing talent by id or name (string), or an inline create object.',
  });
const locationRefSchema = z
  .union([z.string().min(1), createLocationSchema])
  .meta({
    id: 'LocationRef',
    description:
      'Existing location by id or name (string), or an inline create object.',
  });

export const apiCreateSequenceSchema = z
  .object({
    script: z
      .string()
      .min(10)
      .max(50000)
      .meta({
        description:
          'Raw script, or — when enhancement runs — a one-liner / brief to expand.',
        examples: ['A lighthouse keeper befriends a stranded whale.'],
      }),
    title: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .meta({
        description: 'Optional sequence title.',
        examples: ['Sea Tale'],
      }),

    enhance: z.enum(['auto', 'always', 'off']).default('auto').meta({
      description:
        "Script enhancement mode. 'auto' (default) enhances only a short/thin script (mirrors the new-sequence short-script nudge); 'always' forces it; 'off' uses the script verbatim. When enhancement runs, the enhanced script is returned in the response.",
    }),
    targetSeconds: z
      .int()
      .min(5)
      .max(300)
      .optional()
      .meta({
        description:
          'Target video length in seconds (max 5 minutes), applied whenever enhancement runs.',
        examples: [30],
      }),

    style: z
      .string()
      .min(1)
      .optional()
      .meta({
        description:
          'Style by id, name, or slugified name. Omit to auto-pick the most popular available style.',
        examples: ['Cinematic Noir'],
      }),
    aspectRatio: aspectRatioSchema.optional().meta({
      description:
        "Aspect ratio. Defaults to the resolved style's recommendation, else 16:9.",
    }),

    analysisModels: z.array(z.string()).min(1).optional().meta({
      description:
        'Analysis model id(s); one sequence is created per model. Validated against the model registry.',
    }),
    imageModels: z.array(z.string()).min(1).optional().meta({
      description: 'Image model key(s); first is primary.',
    }),
    videoModels: z.array(z.string()).min(1).optional().meta({
      description: 'Video (image-to-video) model key(s); first is primary.',
    }),

    motion: z
      .boolean()
      .default(false)
      .meta({ description: 'Generate motion (video) for each shot.' }),
    music: z
      .boolean()
      .default(false)
      .meta({ description: 'Generate sequence music.' }),
    audioModels: z.array(z.string()).min(1).optional().meta({
      description: 'Audio model key(s) for music; first is primary.',
    }),

    characters: z.array(characterRefSchema).optional().meta({
      description:
        'Cast: each item is an existing ref (id/name) or an inline create object.',
    }),
    locations: z.array(locationRefSchema).optional().meta({
      description:
        'Locations: each item is an existing ref (id/name) or an inline create object.',
    }),

    elements: z
      .array(
        z
          .object({
            url: z.url().meta({ description: 'Hosted image URL to ingest.' }),
            token: z
              .string()
              .min(1)
              .max(100)
              .optional()
              .meta({
                description:
                  'Optional UPPERCASE token to reference the element in prompts; derived by vision when omitted.',
                examples: ['LOGO'],
              }),
            filename: z
              .string()
              .min(1)
              .optional()
              .meta({ description: 'Optional original filename.' }),
          })
          .meta({ id: 'ElementInput' })
      )
      .optional()
      .meta({
        description: 'Reference elements (logos, products) by image URL.',
      }),

    webhookUrl: z.url().optional().meta({
      description:
        'Reserved for phase 2: URL to receive a signed completion webhook. Stored intent only — delivery is not implemented yet.',
    }),
  })
  .refine((data) => !data.music || data.motion, {
    path: ['music'],
    message: MUSIC_REQUIRES_MOTION_ERROR,
  })
  .meta({
    id: 'CreateSequenceRequest',
    title: 'Create Sequence Request',
    description:
      'Input for POST /api/v1/sequences — one-shot video sequence creation.',
  });

export type ApiCreateSequenceInput = z.infer<typeof apiCreateSequenceSchema>;
