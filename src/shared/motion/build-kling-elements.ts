/**
 * Convert resolved reference images into Kling v3 Pro `elements` input (#873).
 *
 * Kling v3 Pro accepts reference images inline on its image-to-video endpoint:
 * it takes an `elements` array of `{ frontal_image_url, reference_image_urls }`
 * and binds each one to the `@Element1`, `@Element2`, … tokens it finds in the
 * prompt (https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video). An
 * image-set element requires BOTH `frontal_image_url` and at least one entry
 * in `reference_image_urls` (fal rejects frontal-only elements); we have a
 * single sheet/product image per character/element, so it fills both fields.
 *
 * Binding is INLINE where possible: each reference's canonical token
 * ("SCARLETT", "CORAL_LIPSTICK") is substituted with its `@ElementN` tag at
 * the narrative moment it appears. References never mentioned in the prompt
 * fall back to a trailing legend line (appended within the model's prompt
 * limit — the base prompt is truncated rather than the legend, so the
 * `@ElementN` bindings always survive; a dropped legend would orphan the
 * element images). No start-frame line is needed here: unlike the
 * reference-to-video endpoints, Kling's normal endpoint has a real start-frame
 * `image_url`.
 *
 * The fal docs cap the combo at 4 reference images total, so we take the first
 * four; overflow references have their tokens replaced with plain descriptions.
 */

import type { ReferenceImageDescription } from '@/shared/prompts/reference-image-prompt';
import {
  appendLegendWithinLimit,
  inlineReferenceDescription,
  substituteReferenceTags,
} from '@/shared/prompts/reference-legend';

/** A single Kling v3 combo element built from one reference image. */
export type KlingComboElement = {
  frontal_image_url: string;
  reference_image_urls: string[];
};

/** fal caps Kling v3 at 4 reference images total (elements + reference images). */
const MAX_KLING_ELEMENTS = 4;

export function buildKlingElementsInput(
  basePrompt: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number
): { prompt: string; elements: KlingComboElement[] } {
  const withUrls = references.filter((ref) => ref.referenceImageUrl);
  const usable = withUrls.slice(0, MAX_KLING_ELEMENTS);
  const overflow = withUrls.slice(MAX_KLING_ELEMENTS);

  if (usable.length === 0) {
    return { prompt: basePrompt, elements: [] };
  }

  const elements: KlingComboElement[] = usable.map((ref) => ({
    frontal_image_url: ref.referenceImageUrl,
    reference_image_urls: [ref.referenceImageUrl],
  }));

  const { prompt: substituted, mentioned } = substituteReferenceTags(
    basePrompt,
    [
      ...usable.map((ref, index) => ({
        token: ref.token,
        render: `@Element${index + 1}`,
      })),
      ...overflow.map((ref) => ({
        token: ref.token,
        render: inlineReferenceDescription(ref),
      })),
    ]
  );

  const legendLines = usable
    .map((ref, index) =>
      mentioned[index] ? null : `@Element${index + 1}: ${ref.description}`
    )
    .filter((line) => line !== null);

  if (legendLines.length === 0) {
    return { prompt: substituted, elements };
  }
  const legend = `Reference elements — keep each visually consistent with its reference image throughout the shot:\n${legendLines.join('\n')}`;
  return {
    prompt: appendLegendWithinLimit(substituted, legend, maxPromptLength),
    elements,
  };
}
