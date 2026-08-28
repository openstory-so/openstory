/**
 * Canonical style `config` schema (v2) and the single v1→v2 conversion path.
 *
 * A style encodes two prescriptive signatures — LOOK (what a still looks like)
 * and MOTION (how the camera and cutting behave; it cannot be derived from a
 * still). The schema is a small required core with optional refinements so
 * quick styles stay compact while curated templates stay rich.
 *
 * Drizzle-free on purpose: importable from client bundles, scripts, and the
 * DB schema layer alike. `src/lib/db/schema/libraries.ts` re-exports the types
 * for the column `$type<>()`.
 *
 * Stored blobs may be v1 (flat) or v2 (grouped). Every read of a stored
 * `styles.config` or `sequences.styleConfig` must go through
 * {@link parseStyleConfig} / {@link resolveSequenceStyleConfig}; the columns
 * are typed `StoredStyleConfig` so direct field access does not compile.
 */
import { z } from 'zod';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'style', 'style-config']);

const prose = z.string().min(3).max(1000);

const StyleLookSchema = z.object({
  mood: prose,
  artStyle: prose,
  lighting: prose,
  colorPalette: z.array(z.string().min(1)).min(1).max(20),
  colorGrading: prose,
  medium: prose.optional(),
});

export const STYLE_PACE_VALUES = [
  'slow',
  'measured',
  'brisk',
  'frenetic',
] as const;

const StyleMotionSchema = z.object({
  camera: prose,
  shots: prose.optional(),
  pace: z.enum(STYLE_PACE_VALUES).optional(),
  /** 1 = stillness, 5 = kinetic chaos. */
  energy: z.number().int().min(1).max(5).optional(),
});

export const StyleConfigSchema = z.object({
  version: z.literal(2),
  look: StyleLookSchema,
  motion: StyleMotionSchema,
  /** Reference works/aesthetics (descriptive phrases, not necessarily titles). */
  references: z.array(z.string().min(1)).max(50).default([]),
});

export type StyleConfig = z.infer<typeof StyleConfigSchema>;

/**
 * Legacy flat shape. Constraints match the pre-v2 schema exactly, so every row
 * written through the old create/update path converts 1:1. Kept until prod
 * catalog rows are rewritten by the seeder (#858 / #1179).
 */
const StyleConfigV1Schema = z.object({
  mood: prose,
  artStyle: prose,
  lighting: prose,
  colorPalette: z.array(z.string().min(1)).min(1).max(20),
  cameraWork: prose,
  referenceFilms: z.array(z.string().min(1)).max(50),
  colorGrading: prose,
});

export type StyleConfigV1 = z.infer<typeof StyleConfigV1Schema>;

/** What the DB column actually holds until the backfill completes. */
export type StoredStyleConfig = StyleConfig | StyleConfigV1;

export function isStyleConfigV2(raw: unknown): raw is StyleConfig {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { version?: unknown }).version === 2
  );
}

/**
 * The one v1→v2 conversion, shared by {@link parseStyleConfig} and the
 * catalog backfill script. Output is validated against the v2 schema so an
 * invariant-violating legacy blob fails loudly here rather than flowing into
 * prompts typed as a valid `StyleConfig`.
 */
export function migrateStyleConfigV1ToV2(raw: unknown): StyleConfig {
  const v1 = StyleConfigV1Schema.parse(raw);
  return StyleConfigSchema.parse({
    version: 2,
    look: {
      mood: v1.mood,
      artStyle: v1.artStyle,
      lighting: v1.lighting,
      colorPalette: v1.colorPalette,
      colorGrading: v1.colorGrading,
    },
    motion: { camera: v1.cameraWork },
    references: v1.referenceFilms,
  });
}

/**
 * Parse a stored `styles.config` blob, up-converting v1. Throws (ZodError) on
 * anything that is neither valid v1 nor valid v2 — corruption must surface,
 * not degrade. Call this at every read boundary.
 */
export function parseStyleConfig(raw: unknown): StyleConfig {
  if (isStyleConfigV2(raw)) return StyleConfigSchema.parse(raw);
  // Observable retirement signal: once this stops firing in prod (backfill
  // complete), the v1 branch and StyleConfigV1Schema can be dropped (#858).
  logger.warn('up-converting v1 style config at read time');
  return migrateStyleConfigV1ToV2(raw);
}

/**
 * Sequence-owned recipe first, live catalog row only as a fallback for
 * pre-snapshot rows. Catalog edits must not win over the snapshot.
 */
export function resolveSequenceStyleConfig(args: {
  snapshot: unknown;
  live?: unknown;
}): StyleConfig {
  if (args.snapshot != null) return parseStyleConfig(args.snapshot);
  if (args.live != null) return parseStyleConfig(args.live);
  throw new Error(
    'Sequence has no style config snapshot and no live style to fall back to'
  );
}

/**
 * The style's contribution to input hashes, as one shared projection.
 *
 * Shape-stable by construction: the base keys are the v1 field names with the
 * same values a v1 blob carried, so the pure v1→v2 reshape changes no stored
 * hash (no `PROMPT_INPUT_HASH_VERSION` bump, no null-sweep migration). The
 * optional refinements join the body only when populated — authoring them is a
 * genuine input change and SHOULD flip staleness. `version` never shapes
 * visual/motion/sheet prompt text, so it is excluded.
 */
export function styleConfigHashBody(
  config: StyleConfig | null | undefined
): Record<string, unknown> | null {
  if (!config) return null;
  const refinements = Object.fromEntries(
    Object.entries({
      medium: config.look.medium,
      shots: config.motion.shots,
      pace: config.motion.pace,
      energy: config.motion.energy,
    }).filter(([, value]) => value !== undefined)
  );
  return {
    mood: config.look.mood,
    artStyle: config.look.artStyle,
    lighting: config.look.lighting,
    colorPalette: config.look.colorPalette,
    cameraWork: config.motion.camera,
    referenceFilms: config.references,
    colorGrading: config.look.colorGrading,
    ...refinements,
  };
}

/**
 * A `Style` row as the pipeline consumes it: parsed config, non-null tags.
 * Build it with {@link toStyleProjection} — the constructor is what makes the
 * guarantees real.
 */
export type StyleProjection = {
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  config: StyleConfig;
};

type StyleRowLike = {
  name: string;
  description: string | null;
  category: string | null;
  tags: string[] | null;
  config: unknown;
};

export function toStyleProjection(row: StyleRowLike): StyleProjection {
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    tags: row.tags ?? [],
    config: parseStyleConfig(row.config),
  };
}

/**
 * Total (never-throwing) accessors for cosmetic UI paths — tiles, gradients,
 * detail rows — where a malformed row must render as "empty", not blank the
 * whole grid with a ZodError mid-render. Server/prompt paths must use
 * {@link parseStyleConfig} instead.
 */
export function getConfigColorPalette(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const source = isStyleConfigV2(raw)
    ? (raw as { look?: { colorPalette?: unknown } }).look
    : (raw as { colorPalette?: unknown });
  const palette = source?.colorPalette;
  return Array.isArray(palette)
    ? palette.filter((c): c is string => typeof c === 'string')
    : [];
}

export type StyleConfigDisplayFields = {
  mood?: string;
  artStyle?: string;
  lighting?: string;
  camera?: string;
  colorGrading?: string;
  references: string[];
};

export function getConfigDisplayFields(raw: unknown): StyleConfigDisplayFields {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  if (typeof raw !== 'object' || raw === null) return { references: [] };
  if (isStyleConfigV2(raw)) {
    const v2 = raw as Partial<StyleConfig>;
    return {
      mood: str(v2.look?.mood),
      artStyle: str(v2.look?.artStyle),
      lighting: str(v2.look?.lighting),
      camera: str(v2.motion?.camera),
      colorGrading: str(v2.look?.colorGrading),
      references: Array.isArray(v2.references)
        ? v2.references.filter((r): r is string => typeof r === 'string')
        : [],
    };
  }
  const v1 = raw as Partial<StyleConfigV1>;
  return {
    mood: str(v1.mood),
    artStyle: str(v1.artStyle),
    lighting: str(v1.lighting),
    camera: str(v1.cameraWork),
    colorGrading: str(v1.colorGrading),
    references: Array.isArray(v1.referenceFilms)
      ? v1.referenceFilms.filter((r): r is string => typeof r === 'string')
      : [],
  };
}
