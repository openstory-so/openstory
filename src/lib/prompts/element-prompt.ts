/**
 * Element Prompt Helpers
 *
 * Builds reference-image descriptors for user-uploaded sequence elements
 * (logos, products, screenshots) that are referenced by UPPERCASE token in
 * the script, and the generation prompt for auto-generated element reference
 * images (recurring products detected during scene split with no upload).
 */

import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { SequenceElementMinimal, StyleConfig } from '@/lib/db/schema';
import type { ReferenceImageDescription } from './reference-image-prompt';

/**
 * Build a concise descriptor for an element for use in reference-image prompts.
 */
export function buildElementDescription(
  element: SequenceElementMinimal
): string {
  const summary = (element.description ?? '').split(/[.,]/)[0]?.trim() ?? '';
  const suffix = summary && summary.length < 120 ? ` - ${summary}` : '';
  return `${element.token}${suffix}`;
}

/**
 * Build role-tagged reference images for elements. Elements must have an
 * imageUrl; description is optional — when vision analysis hasn't finished,
 * the token alone is enough context for the image model since the reference
 * image itself carries the visual identity.
 */
export function buildElementReferenceImages(
  elements: SequenceElementMinimal[]
): ReferenceImageDescription[] {
  return elements
    .filter((el) => el.imageUrl)
    .map((el) => ({
      referenceImageUrl: el.imageUrl,
      description: buildElementDescription(el),
      role: 'element' as const,
      token: el.token,
    }));
}

/**
 * Build the generation prompt for an auto-generated element reference image.
 *
 * Mirrors the spirit of `buildCharacterSheetPrompt`: a clean, canonical
 * reference shot whose only job is to pin down the element's visual identity
 * so downstream frame generation can paste it in consistently. The bible
 * entry's description (authored by the scene-split LLM) carries the identity;
 * the style config (when present) keeps rendering and palette consistent with
 * the sequence so the reference doesn't fight the frames that consume it.
 */
export function buildElementSheetPrompt(
  entry: ElementBibleEntry,
  styleConfig?: StyleConfig
): string {
  const styled = styleConfig
    ? {
        environment: `Render in ${styleConfig.look.artStyle} style. Background: clean, seamless studio backdrop with no environmental detail — simple flat or gradient tone drawn from the style's color palette: ${styleConfig.look.colorPalette.join(', ')}. Color grading: ${styleConfig.look.colorGrading}.`,
        lighting: `${styleConfig.look.lighting}. Even, controlled illumination that reveals true colors, materials, and surface finish.`,
      }
    : {
        environment:
          'Seamless, minimalist commercial photo studio cyclorama with flat neutral background. Clean, sterile, analytical atmosphere designed for clarity.',
        lighting:
          'Neutral, even, high-key studio lighting. Diffused illumination from large softboxes to eliminate harsh shadows and reveal true colors, materials, and surface finish. 5500K daylight balance.',
      };

  return `A professional product reference photograph establishing the canonical look of a recurring object (${entry.consistencyTag}).

[SUBJECT]:
${entry.description}

[FRAMING]:
The object is the sole subject, centered, shown three-quarter angle at a scale that fills most of the frame. Every defining detail — shape, proportions, materials, colors, finish, and any text or branding on the object — must be clearly legible. No hands, no people, no props, no packaging unless it is part of the object itself.

[ENVIRONMENT]:
${styled.environment}

[LIGHTING]:
${styled.lighting}

[MATERIALITY]:
Hyper-accurate rendering of all surfaces, textures, and micro-details. Tack-sharp focus across the entire object, deep depth of field, no lens distortion. This image is the single source of truth for the object's appearance.`.trim();
}
