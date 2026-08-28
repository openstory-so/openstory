/**
 * Decide whether a cast character can keep the talent's existing sheet
 * instead of generating a new costumed one.
 *
 * Default is reuse. Regenerate when role clothing Jaccard against talent
 * clothing (description only if clothing is empty) is below 0.25, or
 * features Jaccard against talent features (physical+description fallback)
 * is below 0.2. Comparison is metadata text, not the sheet image.
 */

export type ReuseTalentSheetInput = {
  characterClothing?: string | null;
  characterFeatures?: string | null;
  talentClothing?: string | null;
  talentFeatures?: string | null;
  talentPhysical?: string | null;
  talentDescription?: string | null;
};

const STOPWORDS = new Set([
  'the',
  'and',
  'or',
  'with',
  'without',
  'wearing',
  'wears',
  'wear',
  'dressed',
  'over',
  'under',
  'from',
  'into',
  'onto',
  'this',
  'that',
  'their',
  'them',
  'they',
  'her',
  'his',
  'she',
  'him',
  'has',
  'have',
  'for',
  'are',
  'was',
  'were',
]);

const GENERIC_CLOTHING = new Set([
  'casual',
  'streetwear',
  'everyday',
  'normal',
  'regular',
  'unspecified',
  'none',
  'n/a',
  'na',
  'unknown',
  'clothes',
  'clothing',
  'outfit',
  'attire',
]);

export function tokenizeAppearance(
  value: string | null | undefined
): Set<string> {
  if (!value) return new Set();
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (token) =>
        token.length > 2 &&
        !STOPWORDS.has(token) &&
        !GENERIC_CLOTHING.has(token)
    );
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function tokensOrFallback(
  primary: string | null | undefined,
  fallback: string | null | undefined
): Set<string> {
  const fromPrimary = tokenizeAppearance(primary);
  if (fromPrimary.size > 0) return fromPrimary;
  return tokenizeAppearance(fallback);
}

/**
 * True unless distinctive role clothing/features fail the Jaccard
 * thresholds against the matching talent field. Empty/generic role
 * wardrobe defaults to reuse.
 */
export function shouldReuseTalentSheet(input: ReuseTalentSheetInput): boolean {
  const characterClothes = tokenizeAppearance(input.characterClothing);
  const characterFeatures = tokenizeAppearance(input.characterFeatures);
  const talentClothes = tokensOrFallback(
    input.talentClothing,
    input.talentDescription
  );
  const talentFeatures = tokensOrFallback(
    input.talentFeatures,
    [input.talentPhysical, input.talentDescription].filter(Boolean).join(' ')
  );

  if (characterClothes.size > 0) {
    if (talentClothes.size === 0) return false;
    if (jaccard(characterClothes, talentClothes) < 0.25) return false;
  }

  if (characterFeatures.size > 0) {
    if (talentFeatures.size === 0) return false;
    if (jaccard(characterFeatures, talentFeatures) < 0.2) return false;
  }

  return true;
}
