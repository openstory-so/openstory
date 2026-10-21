/**
 * Global search (#2100): the hit shape and the snippet shown under a hit.
 */

/** In the order the results are grouped. */
export const SEARCH_KINDS = [
  'sequence',
  'scene',
  'shot',
  'character',
  'sequenceLocation',
  'libraryLocation',
  'image',
  'clip',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  /** The text around the match. Null when only the title matched. */
  snippet: string | null;
  /** The sequence a scene, shot or sequence location belongs to. */
  sequence: { id: string; title: string } | null;
};

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
/** Hits returned per kind. */
export const SEARCH_GROUP_LIMIT = 6;

const SNIPPET_RADIUS = 40;

/** The first text holding `query`, cut to a window around the match. */
export function excerpt(
  texts: readonly (string | null | undefined)[],
  query: string
): string | null {
  const needle = query.toLowerCase();
  for (const text of texts) {
    if (!text) continue;
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
    // One line: script text carries line breaks.
    const window = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`;
  }
  return null;
}
