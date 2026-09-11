/**
 * Element Prompt Helpers
 *
 * Builds reference-image descriptors for user-uploaded sequence elements
 * (logos, products, screenshots) that are referenced by UPPERCASE token in
 * the script, and the generation prompt for auto-generated element reference
 * images (recurring products detected during scene split with no upload).
 */

import { formatElementDuration } from '@/cast/element-kind';
import type { ElementBibleEntry } from '@/shots/scene-analysis.schema';
import type {
  SequenceElementMinimal,
  StyleConfig,
} from '@/platform/server/db/schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

/**
 * Build a concise descriptor for an element for use in reference-image prompts.
 *
 * A clip or an audio file also states its LENGTH (#1559). It is a hint, not a
 * constraint — the model is told how long the reference runs so it can pace a
 * line of dialogue against the shot; only speech actually needs the clip to
 * cover it.
 */
export function buildElementDescription(
  element: SequenceElementMinimal
): string {
  const summary = (element.description ?? '').split(/[.,]/)[0]?.trim() ?? '';
  const suffix = summary && summary.length < 120 ? ` - ${summary}` : '';
  const kind = element.kind ?? 'image';
  const length =
    kind === 'image' ? null : formatElementDuration(element.durationSeconds);
  const media =
    kind === 'image' ? '' : ` [${kind}${length ? `, ${length}` : ''}]`;
  return `${element.token}${suffix}${media}`;
}

/**
 * Build role-tagged references for elements. Elements must have stored media
 * (`imageUrl` holds it for every kind); description is optional — when vision
 * analysis hasn't finished, or the element is a clip or audio file the user
 * hasn't described, the token alone is enough context, since the reference
 * itself carries what the prompt cannot say.
 */
export function buildElementReferenceImages(
  elements: SequenceElementMinimal[]
): ReferenceImageDescription[] {
  return elements.flatMap((el) =>
    el.imageUrl
      ? [
          {
            referenceImageUrl: el.imageUrl,
            description: buildElementDescription(el),
            role: 'element' as const,
            kind: el.kind ?? ('image' as const),
            durationSeconds: el.durationSeconds,
            token: el.token,
          },
        ]
      : []
  );
}

/**
 * The same list for an IMAGE model (#1559). A clip or an audio element has no
 * slot on any image endpoint — handing one over as a `reference_image_url`
 * sends an MP3 where a PNG is expected — so the still paths bind only the
 * image elements and the token falls back to prose. Motion is the only side
 * that can carry the other two.
 */
export function buildElementStillReferences(
  elements: SequenceElementMinimal[]
): ReferenceImageDescription[] {
  return buildElementReferenceImages(
    elements.filter((el) => (el.kind ?? 'image') === 'image')
  );
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
