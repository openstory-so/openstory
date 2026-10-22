import type { StudioCreateInput } from './schema';

/**
 * The stills a studio create would feed the model — what the likeness gate
 * (and Ark) sees. Exhaustive over `mode` so a new video mode cannot slip
 * past the gate ungated.
 */
function studioReferenceImages(input: StudioCreateInput): string[] {
  if (input.activity === 'image') return input.referenceImages;
  switch (input.mode) {
    case 'reference':
      return input.referenceImages;
    case 'frames':
      return [input.startImageUrl, input.endImageUrl].filter(
        (url): url is string => Boolean(url)
      );
    // The source of an edit is a clip this team generated, not an upload.
    // Reference clips are gated in `studioLikenessMedia`.
    case 'edit':
    case 'text':
      return [];
    default:
      input.mode satisfies never;
      return [];
  }
}

/**
 * Everything a studio create sends that the likeness gate checks: the stills,
 * plus reference clips, which Gemini watches whole (#1930).
 * Reference audio has no likeness.
 */
export function studioLikenessMedia(input: StudioCreateInput): string[] {
  const clips =
    input.activity === 'video' && input.mode === 'reference'
      ? input.referenceVideos
      : [];
  return [...studioReferenceImages(input), ...clips];
}
