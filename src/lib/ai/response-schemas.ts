/**
 * LLM Response Schemas
 *
 * Zod schemas for validating structured outputs from each analysis phase.
 * All derive from the canonical scene-analysis.schema.ts definitions.
 */

import { z } from 'zod';

import {
  characterBibleEntrySchema,
  elementBibleEntrySchema,
  locationBibleEntrySchema,
  musicDesignSchema,
  projectMetadataSchema,
} from './scene-analysis.schema';

/**
 * Scene duration estimation (functions/ai.ts). Plain `z.number()` rather than
 * `.int()` / `.min()` / `.max()` — Zod injects JS-safe-integer bounds for
 * `.int()`, and Amazon Bedrock (one of the OpenRouter providers for Sonnet)
 * rejects ANY `minimum`/`maximum` on integer types. Range + integer
 * enforcement happen post-parse via clamp.
 */
export const sceneDurationResponseSchema = z.object({
  durationSeconds: z.number(),
});

/**
 * Style recommendation (functions/ai.ts). The model returns catalog INDICES,
 * not style ids — ULIDs get mangled by the model, and an index maps back
 * unambiguously. Catch-free with plain `z.number()` (no `.int()`/min/max —
 * see sceneDurationResponseSchema). Integer + in-range enforcement for
 * `index` happens post-parse in `rankStyleRecommendations`; `score` is used
 * only for ordering, not bounded.
 */
export const styleRecommendationResponseSchema = z.object({
  recommendations: z.array(
    z.object({
      index: z.number(),
      score: z.number(),
      reasoning: z.string(),
    })
  ),
});

/**
 * Talent Matching Response
 */
export const talentMatchResponseSchema = z.object({
  matches: z.array(
    z.object({
      characterId: z.string(),
      talentId: z.string(),
      confidence: z.number(), // 0-1 range enforced by prompt, not schema (Anthropic doesn't support min/max)
      reason: z.string(),
    })
  ),
});

/**
 * Location Matching Response
 */
export const locationMatchResponseSchema = z.object({
  matches: z.array(
    z.object({
      locationId: z.string(),
      libraryLocationId: z.string(),
      confidence: z.number(), // 0-1 range enforced by prompt
      reason: z.string(),
    })
  ),
});

/**
 * Phase 1: Scene Splitting (#1035 — two parallel calls).
 *
 * The old single mega-call compiled to an 8.2KB JSON-Schema grammar, which
 * every Anthropic model rejects under native strict output (~3.6KB budget).
 * It is replaced by two independent calls over the same script, run
 * concurrently:
 *
 *   1. Scenes call — BOUNDARY ANNOTATION ONLY (#1218). The LLM never
 *      re-emits script text or per-scene metadata: it returns
 *      `{ hintLine, quote }` anchors against a line-gutter copy of the
 *      script. `boundary-split.ts` slices the ORIGINAL script into
 *      byte-verbatim adjacent extracts; title/location/dialogue/duration
 *      are derived locally from each slice; continuity tags are assigned
 *      from bibles ∩ slice after the join. Scene ids / numbers are minted
 *      server-side.
 *   2. Bibles call — character/location/element bibles only.
 */
export const sceneBoundarySchema = z.object({
  hintLine: z.number().meta({
    description:
      '1-based line number (from the numbered gutter) where the scene starts',
  }),
  quote: z.string().meta({
    description:
      'Verbatim copy of the first 40-80 characters of the scene, exactly as they appear in the script (never include the line-number gutter)',
  }),
});

export const sceneSplitScenesResultSchema = z.object({
  projectMetadata: projectMetadataSchema,
  boundaries: z.array(sceneBoundarySchema).meta({
    description:
      'One entry per scene in script order; scene 1 starts at the top of the script and every scene runs until the next boundary',
  }),
});

export type SceneSplitScenesResult = z.infer<
  typeof sceneSplitScenesResultSchema
>;

export const sceneSplitBiblesResultSchema = z.object({
  characterBible: z.array(characterBibleEntrySchema),
  locationBible: z.array(locationBibleEntrySchema),
  elementBible: z.array(elementBibleEntrySchema).meta({
    description:
      'Elements referenced by UPPERCASE token — user-uploaded reference images plus detected recurring products/objects needing a consistent canonical look',
  }),
});

export type SceneSplitBiblesResult = z.infer<
  typeof sceneSplitBiblesResultSchema
>;

/**
 * Music Design + Prompt Generation (combined Phase 7)
 * Classifies each scene's music attributes and synthesizes unified tags + prompt.
 */
export const musicDesignResultSchema = z.object({
  scenes: z
    .array(
      z.object({
        sceneId: z.string().meta({ description: 'Scene identifier' }),
        musicDesign: musicDesignSchema.meta({
          description: 'Music classification for this scene',
        }),
      })
    )
    .meta({ description: 'Per-scene music design classifications' }),
  tags: z.string().meta({
    description:
      'Comma-separated music tags for ACE-Step (must start with "instrumental")',
  }),
  prompt: z.string().meta({
    description:
      '1-2 sentence music prompt describing the overall mood and progression',
  }),
});
