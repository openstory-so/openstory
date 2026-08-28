/**
 * Automatic style (#1213): a style derived from the sequence's own script
 * instead of picked from the library. It lives as a `styles` row bound to the
 * sequence (`styles.sequenceId`), invisible to the library until promoted.
 *
 * Drizzle-free so the composer can import the sentinel and labels.
 */
import { z } from 'zod';
import {
  STYLE_PACE_VALUES,
  StyleConfigSchema,
  type StyleConfig,
} from './style-config';

/** Composer-side sentinel sent as `styleId` to request an automatic style. */
export const AUTO_STYLE_ID = 'auto';

export const AUTO_STYLE_PLACEHOLDER_NAME = 'Automatic style';

export const STYLE_CATEGORIES = [
  'film',
  'commercial',
  'ecommerce',
  'influencer',
  'animatic',
  'animation',
  'kids',
  'tech',
] as const;

const AUTO_STYLE_PLACEHOLDER_CONFIG: StyleConfig = {
  version: 2,
  look: {
    mood: 'grounded, naturalistic',
    artStyle: 'photorealistic live action',
    lighting: 'motivated natural light',
    colorPalette: ['#1a1a1a', '#8c8c8c', '#f2f2f2'],
    colorGrading: 'neutral, true-to-life',
  },
  motion: { camera: 'steady, classical coverage' },
  references: [],
};

/**
 * LLM response shape. Plain strings/numbers only — Anthropic strict output
 * rejects string/array length bounds and integer min/max (see
 * `sceneDurationResponseSchema`). Bounds are applied in
 * {@link autoStyleDraftFromResponse}, which re-validates against the real
 * `StyleConfigSchema`.
 *
 * `category`/`pace` keep their `enum` (a hard constraint on strict routes —
 * Anthropic supports `enum` + `default`) but `.catch()` to a default: this is
 * a guess, and an off-vocabulary word from a non-enforcing route must never
 * fail the run (#1285). Missing recipe strings are filled from a collapsed
 * look/motion paragraph or the placeholder (#1304) if a non-enforcing
 * route still ignores the schema keys.
 */
/** Where a category guess lands when the model coins its own word. */
export const DEFAULT_AUTO_STYLE_CATEGORY = 'film';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstProse(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

/**
 * Non-enforcing routes (OpenRouter→Opus 5, #1304) have emitted `look` /
 * `motion` prose instead of the flat recipe keys, or nested the fields
 * under objects with those names. Lift those into the flat fields so a
 * style guess never fails the run. `z.preprocess` is parse-only —
 * `z.toJSONSchema` still emits the inner object, so the provider schema
 * stays aligned with the prompt (no `look`/`motion` keys).
 */
function coerceCollapsedAutoStyle(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const look = raw.look;
  const motion = raw.motion;
  const lookObj = isRecord(look) ? look : undefined;
  const motionObj = isRecord(motion) ? motion : undefined;
  const lookProse = typeof look === 'string' ? look : undefined;
  const motionProse = typeof motion === 'string' ? motion : undefined;
  const fallback = AUTO_STYLE_PLACEHOLDER_CONFIG.look;
  return {
    ...raw,
    mood: firstProse(raw.mood, lookObj?.mood, lookProse) ?? fallback.mood,
    artStyle:
      firstProse(raw.artStyle, lookObj?.artStyle, lookProse) ??
      fallback.artStyle,
    medium: firstProse(raw.medium, lookObj?.medium) ?? '',
    lighting:
      firstProse(raw.lighting, lookObj?.lighting, lookProse) ??
      fallback.lighting,
    colorGrading:
      firstProse(raw.colorGrading, lookObj?.colorGrading, lookProse) ??
      fallback.colorGrading,
    camera:
      firstProse(raw.camera, motionObj?.camera, motionProse) ??
      AUTO_STYLE_PLACEHOLDER_CONFIG.motion.camera,
    shots: firstProse(raw.shots, motionObj?.shots) ?? '',
  };
}

export const autoStyleResponseSchema = z.preprocess(
  coerceCollapsedAutoStyle,
  z.object({
    name: z.string(),
    description: z.string(),
    category: z.enum(STYLE_CATEGORIES).catch(DEFAULT_AUTO_STYLE_CATEGORY),
    tags: z.array(z.string()),
    mood: z.string(),
    artStyle: z.string(),
    medium: z.string(),
    lighting: z.string(),
    colorPalette: z.array(z.string()),
    colorGrading: z.string(),
    camera: z.string(),
    shots: z.string(),
    pace: z.enum(STYLE_PACE_VALUES).catch('measured'),
    /** 1 = stillness, 5 = kinetic chaos. */
    energy: z.number(),
    references: z.array(z.string()),
  })
);

export type AutoStyleResponse = z.infer<typeof autoStyleResponseSchema>;

export type AutoStyleDraft = {
  name: string;
  description: string | null;
  config: StyleConfig;
  category: string | null;
  tags: string[];
};

/** The row as created at sequence creation, before the run derives the recipe. */
export function placeholderAutoStyleDraft(): AutoStyleDraft {
  return {
    name: AUTO_STYLE_PLACEHOLDER_NAME,
    description: null,
    config: AUTO_STYLE_PLACEHOLDER_CONFIG,
    category: null,
    tags: [],
  };
}

const MAX_NAME_LENGTH = 60;

function clampProse(value: string): string {
  return value.trim().slice(0, 1000);
}

function nonEmpty(values: string[], max: number): string[] {
  return values
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Coerce the free-form LLM answer into a valid `StyleConfig` + row fields.
 * Throws (ZodError) only if the model returned something unsalvageable, e.g.
 * an empty palette or name. The caller decides what that failure means.
 */
export function autoStyleDraftFromResponse(
  response: AutoStyleResponse
): AutoStyleDraft {
  const name = z
    .string()
    .min(1)
    .parse(response.name.trim().slice(0, MAX_NAME_LENGTH));
  const config = StyleConfigSchema.parse({
    version: 2,
    look: {
      mood: clampProse(response.mood),
      artStyle: clampProse(response.artStyle),
      lighting: clampProse(response.lighting),
      colorPalette: nonEmpty(response.colorPalette, 20),
      colorGrading: clampProse(response.colorGrading),
      medium: response.medium.trim() ? clampProse(response.medium) : undefined,
    },
    motion: {
      camera: clampProse(response.camera),
      shots: response.shots.trim() ? clampProse(response.shots) : undefined,
      pace: response.pace,
      energy: Math.min(5, Math.max(1, Math.round(response.energy))),
    },
    references: nonEmpty(response.references, 50),
  });
  return {
    name,
    description: response.description.trim() || null,
    config,
    category: response.category,
    tags: nonEmpty(response.tags, 10),
  };
}
