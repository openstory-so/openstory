/**
 * Which studio reference images need a rights sign-off (#1581).
 *
 * Client-safe: the composer uses it to decide which tiles to classify and
 * the server uses the same rule as the gate, so the two cannot disagree.
 *
 * Gated: anything the user brought in themselves — a temp upload (drop,
 * paste, picker Upload) or a raw http(s) URL. Exempt: every other stored
 * `/r2/` object, which is either something we generated (provenance on
 * record) or a library row written through its own attested flow (talent
 * media, elements).
 */

import type { StudioCreateInput } from './schema';

export function needsReferenceAttestation(url: string): boolean {
  return /^https?:\/\//.test(url) || /^\/r2\/talent\/[^/]+\/temp\//.test(url);
}

/** The stills a create would feed the model — what the gate (and Ark) sees. */
export function studioReferenceImages(input: StudioCreateInput): string[] {
  if (input.activity === 'image' || input.mode === 'reference') {
    return input.referenceImages;
  }
  if (input.mode === 'frames') {
    return [input.startImageUrl, input.endImageUrl].filter(
      (url): url is string => Boolean(url)
    );
  }
  return [];
}
