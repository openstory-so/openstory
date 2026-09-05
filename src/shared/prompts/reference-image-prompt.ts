import { getLogger } from '@/shared/observability/logger';
import {
  appendLegendWithinLimit,
  substituteReferenceTags,
} from './reference-legend';

const logger = getLogger(['openstory', 'prompts', 'reference-image-prompt']);
/**
 * Result of building a prompt with character references
 */
export type PromptWithReferenceImages = {
  /** Enhanced prompt with character reference mapping appended */
  prompt: string;
  /** Array of character sheet URLs in order (for image_urls parameter) */
  referenceUrls: string[];
};

export type ReferenceImageDescription = {
  referenceImageUrl: string;
  description: string;
  /** Role distinguishes the primary scene from supporting reference images */
  role?: 'primary' | 'character' | 'location' | 'element';
  /**
   * The canonical token this entity is named by in prompts — a character's
   * bible name (e.g. "Scarlett") or an element's UPPERCASE token (e.g.
   * "CORAL_LIPSTICK"). Builders substitute occurrences with the model's
   * reference binding — image models get `SCARLETT (Image 2)`, video models
   * get `@Image2`/`@Element1` — or, for models without reference support,
   * the description (#873).
   */
  token?: string;
};

/** Ordering weight per role: primary first, then the supporting refs. */
const ROLE_ORDER: Record<
  NonNullable<ReferenceImageDescription['role']> | 'other',
  number
> = {
  primary: 0,
  character: 1,
  location: 2,
  element: 3,
  other: 4,
};

/**
 * One-line identity guard replacing the old IMPORTANT paragraph: reference
 * images carry identity; they must never be reproduced as output subjects.
 * Doubles as the legend header so the whole reference section stays one
 * strippable unit. Phrased as cross-panel CONSISTENCY, not likeness
 * replication — "match this person exactly" language (like enumerating
 * face/skin features to copy) trips OpenAI's real-person likeness
 * moderation on gpt-image edit endpoints.
 */
const IDENTITY_GUARD =
  'Reference images define identity — keep every referenced character, object, and location consistent with its reference image; never render a reference image itself as a separate panel or subject.';

/**
 * Strip everything this builder (or its predecessors) may have appended to a
 * stored prompt, so enhancement is idempotent: the legacy
 * `<reference-images>` block, the legacy `CHARACTER REFERENCES` section, the
 * current identity-guard legend, and inline `(Image N)` bindings.
 */
function stripExistingReferenceSections(prompt: string): string {
  return prompt
    .replace(/<reference-images>[\s\S]*?<\/reference-images>/g, '')
    .replace(/CHARACTER REFERENCES[\s\S]*$/, '')
    .replace(/\n*Reference images define identity —[\s\S]*$/, '')
    .replace(/ \(Image \d+\)/g, '')
    .trimEnd();
}

/**
 * Build a prompt with reference images, binding them INLINE where possible
 * (#873 — mirrors the motion builders).
 *
 * References carrying a `token` that the prose mentions are bound in place:
 * `SCARLETT` becomes `SCARLETT (Image 2)` at each occurrence, tying the
 * entity to its slot in the ordered `image_urls` array at the narrative
 * moment it appears. References never mentioned (locations, the primary
 * source, token-less refs) fall back to one legend line each under a single
 * identity-guard header — no labeled block, no per-role instruction
 * paragraphs.
 *
 * @param basePrompt - The original prompt
 * @param references - The reference images (order determines Image numbering:
 *   primary, characters, locations, elements, untyped)
 * @param maxPromptLength - If set, truncate the base prompt to fit within this
 *   total limit while preserving the legend in full (a dropped legend would
 *   orphan the reference images).
 * @returns The enhanced prompt and ordered reference URLs
 */
export function buildReferenceImagePrompt(
  basePrompt: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number
): PromptWithReferenceImages {
  const stripped = stripExistingReferenceSections(basePrompt);
  if (references.length === 0) {
    return { prompt: stripped, referenceUrls: [] };
  }

  const ordered = [...references].sort(
    (a, b) => ROLE_ORDER[a.role ?? 'other'] - ROLE_ORDER[b.role ?? 'other']
  );

  const { prompt: substituted, mentioned } = substituteReferenceTags(
    stripped,
    ordered.map((ref, index) => ({
      token: ref.role === 'primary' ? undefined : ref.token,
      render: `${ref.token} (Image ${index + 1})`,
    }))
  );

  const legendLines = ordered
    .map((ref, index) => {
      if (mentioned[index]) return null;
      const roleLabel = ref.role ? ` (${ref.role})` : '';
      return `Image ${index + 1}${roleLabel}: ${ref.description}`;
    })
    .filter((line) => line !== null);

  const legend = [IDENTITY_GUARD, ...legendLines].join('\n');
  const prompt = appendLegendWithinLimit(substituted, legend, maxPromptLength);
  if (maxPromptLength && prompt.length > maxPromptLength) {
    // Only possible when the legend alone exceeds the limit (absurdly long
    // descriptions) — appendLegendWithinLimit returned the legend whole and
    // the downstream per-model truncation will clamp it.
    logger.warn(
      `Reference legend (${legend.length} chars) exceeds maxPromptLength (${maxPromptLength})`
    );
  }

  return {
    prompt,
    referenceUrls: ordered.map((ref) => ref.referenceImageUrl),
  };
}
