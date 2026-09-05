/**
 * Extracts canonical character / element / location tags mentioned in a
 * user-edited prompt, so the next regeneration picks them up via
 * `shot.metadata.continuity`.
 *
 * Strict matching: each entity is searched whole-word. Identifier/slug forms
 * (characterId, consistencyTag slug, element token, location slug) match
 * case-insensitively. Cast ALSO matches by ALL-CAPS name, but case-SENSITIVELY
 * — the deliberate `SCARLETT` reference, not a lowercase prose mention (mirrors
 * tagify's pill rule). No fuzzy name matching — predictable, no false
 * positives. Returns additions only; the caller merges them with the existing
 * continuity so removals from the prompt don't drop linked items.
 */

import type { Continuity } from '@/lib/ai/scene-analysis.schema';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { matchElementsToScene } from '@/shared/scenes/scene-matching';

type CharacterTerm = Pick<
  CharacterMinimal,
  'name' | 'characterId' | 'consistencyTag'
>;
type LocationTerm = Pick<
  SequenceLocationMinimal,
  'locationId' | 'consistencyTag'
>;

export type ContinuityAdditions = {
  characterTags: string[];
  elementTags: string[];
  /**
   * The matched location term, or null if none. The caller decides whether
   * to set or append based on the current `environmentTag` value.
   */
  environmentTag: string | null;
};

/**
 * Drizzle stores `consistencyTag` as `"char_001: jack-denim-jacket"`. Users
 * type either side of the colon, so we expose both halves as search terms.
 */
function consistencyTagSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  const slug = (idx >= 0 ? raw.slice(idx + 1) : raw).trim();
  return slug.length > 0 ? slug : null;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word match for a tag that may contain hyphens/underscores. The
 * boundary class excludes hyphen so `jack-denim-jacket` matches a single
 * term and isn't broken into pieces.
 */
function tagMatchesText(
  tag: string,
  text: string,
  caseSensitive = false
): boolean {
  const escaped = escapeForRegex(tag);
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escaped}(?:[^A-Za-z0-9_-]|$)`,
    caseSensitive ? '' : 'i'
  );
  return re.test(text);
}

function termsFromConsistencyTag(
  id: string,
  consistencyTag: string | null | undefined
): string[] {
  const slug = consistencyTagSlug(consistencyTag);
  return slug ? [id, slug] : [id];
}

export function extractContinuityFromPrompt(args: {
  promptText: string;
  characters: CharacterTerm[];
  elements: SequenceElementMinimal[];
  locations: LocationTerm[];
  existing: Pick<
    Continuity,
    'characterTags' | 'elementTags' | 'environmentTag'
  >;
}): ContinuityAdditions {
  const { promptText, characters, elements, locations, existing } = args;

  if (!promptText.trim()) {
    return { characterTags: [], elementTags: [], environmentTag: null };
  }

  const existingCharacterTagsLower = new Set(
    existing.characterTags.map((t) => t.toLowerCase())
  );
  const existingElementTagsUpper = new Set(
    (existing.elementTags ?? []).map((t) => t.toUpperCase())
  );
  const existingEnvLower = existing.environmentTag.toLowerCase();

  const characterAdditions: string[] = [];
  for (const char of characters) {
    // Cast mentions insert the ALL-CAPS name — match it case-sensitively so we
    // link the deliberate `SCARLETT` reference, not a lowercase prose mention
    // (mirrors tagify's pill rule). The characterId / consistencyTag slug stay
    // case-insensitive — they're the canonical continuity forms.
    const nameUpper = char.name.toUpperCase();
    const idSlugTerms = termsFromConsistencyTag(
      char.characterId,
      char.consistencyTag
    );
    const matched = tagMatchesText(nameUpper, promptText, true)
      ? nameUpper
      : idSlugTerms.find((term) => tagMatchesText(term, promptText));
    if (!matched) continue;
    const canonical = matched.toLowerCase();
    if (existingCharacterTagsLower.has(canonical)) continue;
    if (characterAdditions.includes(canonical)) continue;
    characterAdditions.push(canonical);
  }

  const elementAdditions = matchElementsToScene(elements, [], promptText)
    .map((el) => el.token.toUpperCase())
    .filter((token) => !existingElementTagsUpper.has(token));

  let environmentTag: string | null = null;
  let earliestIndex = Number.POSITIVE_INFINITY;
  const promptLower = promptText.toLowerCase();
  for (const loc of locations) {
    const terms = termsFromConsistencyTag(loc.locationId, loc.consistencyTag);
    for (const term of terms) {
      if (!tagMatchesText(term, promptText)) continue;
      const termLower = term.toLowerCase();
      if (existingEnvLower.includes(termLower)) continue;
      const idx = promptLower.indexOf(termLower);
      if (idx >= 0 && idx < earliestIndex) {
        earliestIndex = idx;
        environmentTag = termLower;
      }
    }
  }

  return {
    characterTags: characterAdditions,
    elementTags: elementAdditions,
    environmentTag,
  };
}

/**
 * Apply the additions returned by `extractContinuityFromPrompt` to a
 * continuity object, returning the merged result. `environmentTag` is
 * space-appended (deduped) so the substring-based location matcher resolves
 * both the original tag and the new one.
 */
export function mergeContinuityAdditions(
  current: Continuity,
  additions: ContinuityAdditions
): Continuity {
  const characterTags =
    additions.characterTags.length > 0
      ? [...current.characterTags, ...additions.characterTags]
      : current.characterTags;

  const elementTags =
    additions.elementTags.length > 0
      ? [...(current.elementTags ?? []), ...additions.elementTags]
      : current.elementTags;

  let environmentTag = current.environmentTag;
  if (additions.environmentTag) {
    const existing = environmentTag.trim();
    environmentTag = existing
      ? `${existing} ${additions.environmentTag}`
      : additions.environmentTag;
  }

  return { ...current, characterTags, elementTags, environmentTag };
}

export function hasContinuityAdditions(a: ContinuityAdditions): boolean {
  return (
    a.characterTags.length > 0 ||
    a.elementTags.length > 0 ||
    a.environmentTag !== null
  );
}
