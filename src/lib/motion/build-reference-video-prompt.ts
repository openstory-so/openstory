/**
 * Build reference-to-video input (prompt + image_urls) from the rendered still
 * + cast/element reference images (#873).
 *
 * Unlike Kling (whose `elements` field rides on the normal image-to-video
 * endpoint), models in `MOTION_REFERENCE_ENDPOINTS` accept references only on
 * a separate reference-to-video endpoint that has NO start-frame `image_url`.
 * It takes an image list (`image_urls` or `reference_image_urls`) bound to
 * prompt tokens — Seedance's `@Image1…N`, H3 Max's `Image 1…N` — via the
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
 *
 * REFERENCE-ONLY (`startImageUrl: null`): no still was ever rendered, so slot
 * 1 belongs to the first real reference and the starting-frame line is
 * dropped — telling the model to open on `@Image1` when `@Image1` is a
 * character sheet makes it open on the sheet, flat lighting and all. The
 * whole `maxImages` budget goes to references, and the prompt itself carries
 * the composition the still would otherwise have supplied (see the
 * reference-only motion prompt template in `workflow-prompts.ts`).
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
  /** The rendered still, or null in reference-only mode (no start frame). */
  startImageUrl: string | null,
  references: ReferenceImageDescription[],
  maxPromptLength?: number,
  options?: { skipLegend?: boolean }
): { prompt: string; imageUrls: string[] } {
  // The still, when there is one, always takes the first slot; cast/element
  // refs fill the rest. Reference-only frees that slot for a real reference,
  // which also shifts every tag down by one.
  const firstReferenceSlot = startImageUrl ? 2 : 1;
  const referenceBudget = config.maxImages - (startImageUrl ? 1 : 0);
  const withUrls = references.filter((ref) => ref.referenceImageUrl);
  const usable = withUrls.slice(0, referenceBudget);
  const overflow = withUrls.slice(referenceBudget);

  const imageUrls = [
    ...(startImageUrl ? [startImageUrl] : []),
    ...usable.map((ref) => ref.referenceImageUrl),
  ];

  const { prompt: substituted, mentioned } = substituteReferenceTags(
    basePrompt,
    [
      // Attached refs bind inline to their tag.
      ...usable.map((ref, index) => ({
        token: ref.token,
        render: config.tag(index + firstReferenceSlot),
      })),
      // Overflow refs have no image slot — swap tokens for descriptions.
      ...overflow.map((ref) => ({
        token: ref.token,
        render: inlineReferenceDescription(ref),
      })),
    ]
  );

  // Reference-only has no starting frame to declare, and pointing the model
  // at `@Image1` there would make it open on a character sheet.
  const body = startImageUrl
    ? `Use ${config.tag(1)} as the starting frame.\n${substituted}`
    : substituted;

  // Legend fallback: attached refs whose token never appeared in the prompt
  // would otherwise be orphaned images.
  const legendLines = options?.skipLegend
    ? []
    : usable
        .map((ref, index) =>
          mentioned[index]
            ? null
            : `${config.tag(index + firstReferenceSlot)}: ${ref.description} — keep visually consistent throughout the shot.`
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
