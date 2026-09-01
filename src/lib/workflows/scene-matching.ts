/**
 * Scene matching utilities
 *
 * Pure functions for matching characters and locations to scenes
 * by their continuity tags. Used by analyze-script and shot-images workflows.
 */

import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';

type CharacterMatchInput = Pick<
  CharacterMinimal,
  'name' | 'characterId' | 'consistencyTag'
>;

// Tokenizes any cased/spaced/punctuated form into a set of snake_case-style
// word tokens, so `"Subject (Anonymous)"` and `"anonymous_subject_..."`
// share the {subject, anonymous} tokens regardless of order.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSubset(needle: string[], haystack: Set<string>): boolean {
  if (needle.length === 0) return false;
  return needle.every((t) => haystack.has(t));
}

/**
 * Boolean: does any tag in `characterTags` refer to this character?
 *
 * Token-subset match: the character's `name` tokens must be a subset of
 * the tag's tokens (or vice versa for partial references). This is
 * invariant to case, spaces, punctuation, and word order — so
 * `"Subject (Anonymous)"` matches `"anonymous_subject_tattooed_..."`,
 * and `"jack"` no longer accidentally matches `"jacket_of_doom"`.
 *
 * `name` is the authoritative match key (stable across recast and what
 * the LLM is told to emit). `characterId` and `consistencyTag` are
 * fallbacks for legacy shots whose tags pre-date the prompt fix.
 */
export function matchCharacterToShotTags(
  character: CharacterMatchInput,
  characterTags: string[]
): boolean {
  if (characterTags.length === 0) return false;

  const nameTokens = tokenize(character.name);
  const idTokens = tokenize(character.characterId);
  const consistencyTokens = character.consistencyTag
    ? tokenize(character.consistencyTag)
    : [];

  return characterTags.some((rawTag) => {
    const tagTokens = tokenize(rawTag);
    if (tagTokens.length === 0) return false;
    const tagSet = new Set(tagTokens);

    // Authoritative: name tokens
    if (isSubset(nameTokens, tagSet)) return true;
    // Reverse (partial name reference): tag is just part of the name
    const nameSet = new Set(nameTokens);
    if (isSubset(tagTokens, nameSet)) return true;

    // Fallback: characterId — tag must contain every characterId token
    if (isSubset(idTokens, tagSet)) return true;

    // Fallback: consistencyTag — both directions
    if (isSubset(consistencyTokens, tagSet)) return true;
    const consistencySet = new Set(consistencyTokens);
    if (isSubset(tagTokens, consistencySet)) return true;

    return false;
  });
}

/**
 * Match characters to a scene by their continuity tags.
 * Pure function that works in-memory without DB queries.
 */
export function matchCharactersToScene<T extends CharacterMatchInput>(
  allCharacters: T[],
  characterTags: string[]
): T[] {
  if (characterTags.length === 0) return [];
  return allCharacters.filter((c) =>
    matchCharacterToShotTags(c, characterTags)
  );
}

/**
 * Strip `"char_001: jack-denim-jacket"` down to the slug half. Same split
 * `extract-continuity-from-prompt` uses — kept local to avoid a cycle.
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
 * Whole-word match. Hyphen/underscore stay inside the token so
 * `jack-denim-jacket` is one term. `caseSensitive` is for ALL-CAPS cast
 * names (the deliberate `SCARLETT` mention, not lowercase prose).
 */
function tagMatchesText(
  tag: string,
  text: string,
  caseSensitive = false
): boolean {
  if (!tag) return false;
  const escaped = escapeForRegex(tag);
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escaped}(?:[^A-Za-z0-9_-]|$)`,
    caseSensitive ? '' : 'i'
  );
  return re.test(text);
}

/**
 * Did this visual prompt name the character the way prompts actually do
 * (#1432)? ALL-CAPS name is case-sensitive (mirrors tagify / the continuity
 * rescan); `characterId` and the consistencyTag slug are case-insensitive.
 */
export function characterMentionedInPrompt(
  character: CharacterMatchInput,
  prompt: string
): boolean {
  if (!prompt.trim()) return false;
  const nameUpper = character.name.toUpperCase();
  if (nameUpper.length > 0 && tagMatchesText(nameUpper, prompt, true)) {
    return true;
  }
  if (tagMatchesText(character.characterId, prompt)) return true;
  const slug = consistencyTagSlug(character.consistencyTag);
  return slug != null && tagMatchesText(slug, prompt);
}

/**
 * Characters whose sheets should attach to a still (#1432).
 *
 * Continuity tags stay the primary match (a tagged character may be described
 * without an ALL-CAPS name). The visual prompt is additive: a regenerated
 * prompt that names `SCARLETT` still attaches her sheet when tags are empty
 * or stale — the same fallback `matchElementsToShotImage` already has for
 * tokens. Update all's chained stills skip `rescanContinuityFromPrompt`, so
 * this is the path that actually sends the refs.
 */
export function matchCharactersToShotImage<T extends CharacterMatchInput>(
  allCharacters: T[],
  args: {
    characterTags?: string[] | null;
    visualPrompt?: string | null;
  }
): T[] {
  const tagged = matchCharactersToScene(
    allCharacters,
    args.characterTags ?? []
  );
  const prompt = (args.visualPrompt ?? '').trim();
  if (!prompt) return tagged;

  const seen = new Set(tagged.map((c) => c.characterId));
  const extra = allCharacters.filter(
    (c) => !seen.has(c.characterId) && characterMentionedInPrompt(c, prompt)
  );
  return extra.length === 0 ? tagged : [...tagged, ...extra];
}

type LocationMatchInput = Pick<
  SequenceLocationMinimal,
  'locationId' | 'name' | 'consistencyTag'
>;

/**
 * Match locations to a scene by environment tag or location name.
 * Pure function that works in-memory without DB queries.
 *
 * Generic so we can reuse it on `LocationBibleEntry` (same id/name/tag shape)
 * when narrowing the bible for prompt-input hashing.
 */
export function matchLocationsToScene<T extends LocationMatchInput>(
  allLocations: T[],
  environmentTag: string,
  sceneLocation: string
): T[] {
  if (!environmentTag && !sceneLocation) return [];

  const envTagLower = environmentTag.toLowerCase();
  const sceneLocLower = sceneLocation.toLowerCase();

  return allLocations.filter((loc) => {
    const consistencyTag = (loc.consistencyTag ?? '').toLowerCase();
    const locName = loc.name.toLowerCase();
    const locId = loc.locationId.toLowerCase();
    const searchTerms = [
      locName,
      locId,
      ...(consistencyTag ? [consistencyTag] : []),
    ].filter((t) => t.length > 0);

    // Forward match: a location identifier appears in the env/scene-location
    // tag. Reverse match: the env/scene-location tag appears in a location
    // identifier. Both directions guard against empty haystacks — without the
    // length check, `'forest'.includes('')` returns true for every location
    // when only one of envTagLower / sceneLocLower is populated.
    return searchTerms.some(
      (term) =>
        (envTagLower.length > 0 && envTagLower.includes(term)) ||
        (sceneLocLower.length > 0 && sceneLocLower.includes(term)) ||
        (envTagLower.length > 0 && term.includes(envTagLower)) ||
        (sceneLocLower.length > 0 && term.includes(sceneLocLower))
    );
  });
}

type ElementMatchInput = Pick<SequenceElementMinimal, 'token'>;

/**
 * Match user-uploaded elements to a scene or prompt by their UPPERCASE_SNAKE
 * `token` — the single element identifier used everywhere: the script,
 * `continuity.elementTags[]`, the prompts, reference-image binding, and the
 * editor pills. (The vision-LLM `consistencyTag` is a descriptive slug used
 * only to label reference-sheet generation, never as an identifier.)
 *
 * Primary match: `elementTags[]` (emitted by the LLM during scene-split).
 * Fallback match: the token appears verbatim in the text — catches references
 * the model forgot to put in `elementTags[]`.
 *
 * Generic so we can reuse it on `ElementBibleEntry` (same token shape) when
 * narrowing the bible for prompt-input hashing.
 */
export function matchElementsToScene<T extends ElementMatchInput>(
  allElements: T[],
  elementTags: string[],
  sceneScript?: string
): T[] {
  if (allElements.length === 0) return [];

  const tagsUpper = new Set(elementTags.map((t) => t.toUpperCase()));
  const scriptUpper = (sceneScript ?? '').toUpperCase();

  return allElements.filter((el) => {
    const token = el.token.toUpperCase();
    if (tagsUpper.has(token)) return true;
    // Whole-token match in the script text. Escape the token (arbitrary user
    // text) so regex metacharacters can't false-match or throw.
    const re = new RegExp(
      `(?:^|[^A-Z0-9_])${escapeRegex(token)}(?:[^A-Z0-9_]|$)`
    );
    return re.test(scriptUpper);
  });
}

/** Prompt wins; else tags + extract. */
export function matchElementsToShotImage<T extends ElementMatchInput>(
  allElements: T[],
  args: {
    visualPrompt?: string | null;
    elementTags?: string[] | null;
    sceneExtract?: string | null;
  }
): T[] {
  const prompt = (args.visualPrompt ?? '').trim();
  if (prompt.length > 0) {
    return matchElementsToScene(allElements, [], prompt);
  }
  return matchElementsToScene(
    allElements,
    args.elementTags ?? [],
    args.sceneExtract ?? ''
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
