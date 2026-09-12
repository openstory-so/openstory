import type { StudioCreateInput } from './schema';

/**
 * The stills a studio create would feed the model — what the likeness gate
 * (and Ark) sees. Exhaustive over `mode` so a new video mode cannot slip
 * past the gate ungated.
 */
export function studioReferenceImages(input: StudioCreateInput): string[] {
  if (input.activity === 'image') return input.referenceImages;
  switch (input.mode) {
    case 'reference':
      return input.referenceImages;
    case 'frames':
      return [input.startImageUrl, input.endImageUrl].filter(
        (url): url is string => Boolean(url)
      );
    case 'text':
      return [];
    default:
      input.mode satisfies never;
      return [];
  }
}
