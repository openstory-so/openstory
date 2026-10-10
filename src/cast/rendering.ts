/**
 * What a character is rendered as (#2017): "Photoreal live action", "3D
 * animated, Pixar-like", "2D cel animation". One required line on the bible
 * version, filled by analysis from the sequence's style, and the only thing
 * a sheet takes from a style: the sequence's palette and grade apply at the
 * shot. Null exactly when the character is voice-only.
 */
import { ValidationError } from '@/platform/errors';
import type { StyleConfig } from '@/look/style-config';

export const PHOTOREAL_RENDERING = 'Photoreal live action';

/**
 * A style's medium, else its art style, else photoreal when there is no
 * style. No system template sets a medium, so the art style is what keeps a
 * claymation sequence's characters out of photoreal.
 */
export function renderingOfStyle(
  style: StyleConfig | null | undefined
): string {
  return (
    style?.look.medium?.trim() ||
    style?.look.artStyle.trim() ||
    PHOTOREAL_RENDERING
  );
}

/**
 * The rendering a bible version stores: null for a voice-only character,
 * required text for every other. Every bible writer passes through here.
 */
export function renderingFor(bible: {
  voiceOnly: boolean;
  rendering: string | null;
}): string | null {
  if (bible.voiceOnly) return null;
  const text = bible.rendering?.trim();
  if (!text) {
    throw new ValidationError(
      'Rendering is required for a character that is seen: say what it is rendered as, such as "Photoreal live action" or "3D animated, Pixar-like".'
    );
  }
  return text;
}
