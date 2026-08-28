/**
 * Build reference-to-video input (prompt + image_urls) from the rendered still
 * + cast/element reference images (#873).
 *
 * Unlike Kling (whose `elements` field rides on the normal image-to-video
 * endpoint), models in `MOTION_REFERENCE_ENDPOINTS` accept references only on
 * a separate reference-to-video endpoint that has NO start-frame `image_url`.
 * It takes an `image_urls[]` array whose entries are bound to prompt tokens —
 * Seedance's `@Image1…N`, Gemini Omni Flash's `<IMAGE_REF_0>…` — via the
 * endpoint's `tag` config.
 *
 * Binding follows the vendors' own prompt examples: the FIRST line declares
 * the still as the starting frame ("Use @Image1 as the starting frame." —
 * critical, since this endpoint has no start-frame parameter), and each
 * reference is bound INLINE by substituting its canonical token ("SCARLETT",
 * "CORAL_LIPSTICK") with the model's tag at the exact narrative moment it
 * appears. References never mentioned in the prompt fall back to a trailing
 * legend line so their images aren't orphaned.
 *
 * The endpoint's `maxImages` caps the total; the still consumes one slot, so
 * at most `maxImages - 1` references are taken. Overflow references have
 * their tokens replaced with plain descriptions instead, keeping the prompt
 * self-contained.
 */

import type { MotionReferenceEndpointConfig } from '@/lib/ai/models';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  appendLegendWithinLimit,
  inlineReferenceDescription,
  substituteReferenceTags,
} from '@/lib/prompts/reference-legend';

export function buildReferenceVideoPrompt(
  config: MotionReferenceEndpointConfig,
  basePrompt: string,
  startImageUrl: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number,
  options?: { skipLegend?: boolean }
): { prompt: string; imageUrls: string[] } {
  // The still always takes the first slot; cast/element refs fill the rest.
  const withUrls = references.filter((ref) => ref.referenceImageUrl);
  const usable = withUrls.slice(0, config.maxImages - 1);
  const overflow = withUrls.slice(config.maxImages - 1);

  const imageUrls = [
    startImageUrl,
    ...usable.map((ref) => ref.referenceImageUrl),
  ];

  const { prompt: substituted, mentioned } = substituteReferenceTags(
    basePrompt,
    [
      // Attached refs bind inline to their tag (still is tag(1), refs follow).
      ...usable.map((ref, index) => ({
        token: ref.token,
        render: config.tag(index + 2),
      })),
      // Overflow refs have no image slot — swap tokens for descriptions.
      ...overflow.map((ref) => ({
        token: ref.token,
        render: inlineReferenceDescription(ref),
      })),
    ]
  );

  const startLine = `Use ${config.tag(1)} as the starting frame.`;
  const body = `${startLine}\n${substituted}`;

  // Legend fallback: attached refs whose token never appeared in the prompt
  // would otherwise be orphaned images.
  const legendLines = options?.skipLegend
    ? []
    : usable
        .map((ref, index) =>
          mentioned[index]
            ? null
            : `${config.tag(index + 2)}: ${ref.description} — keep visually consistent throughout the shot.`
        )
        .filter((line) => line !== null);

  if (legendLines.length === 0) {
    return { prompt: body, imageUrls };
  }
  const legend = `Reference images:\n${legendLines.join('\n')}`;
  return {
    prompt: appendLegendWithinLimit(body, legend, maxPromptLength),
    imageUrls,
  };
}
