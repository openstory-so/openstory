import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';

type TalentMatchPromptRow = {
  id: string;
  name: string;
  description: string | null;
  referenceSheet: {
    metadata?: CharacterBibleEntry | null;
  } | null;
};

/**
 * Build prompt variables for the talent matching prompt.
 * Used by the analyze-script workflow with durableLLMCall.
 *
 * One talent may play several characters (twins, a one-person skit, #2018);
 * each character gets at most one talent. So at most one match per
 * character is expected, and a talent is left out only when no character
 * suits it.
 */
export function buildMatchingPromptVariables(
  characters: CharacterBibleEntry[],
  talentList: TalentMatchPromptRow[]
) {
  const charactersDescription = characters
    .map(
      (c) => `- Character ID: ${c.characterId}
  Name: ${c.name}
  Age: ${c.age}
  Gender: ${c.gender}
  Ethnicity: ${c.ethnicity}
  Physical: ${c.physicalDescription}
  Clothing: ${c.standardClothing}
  Distinguishing features: ${c.distinguishingFeatures}`
    )
    .join('\n\n');

  const talentDescription = talentList
    .map((t) => {
      const metadata = t.referenceSheet?.metadata;
      // Use metadata if available, otherwise use basic talent info
      // For famous actors, their name alone is enough for the AI to know them
      return `- Talent ID: ${t.id}
  Name: ${t.name}
  Age: ${metadata?.age ?? 'unspecified (infer from name if recognizable)'}
  Gender: ${metadata?.gender ?? 'unspecified (infer from name if recognizable)'}
  Ethnicity: ${metadata?.ethnicity ?? 'unspecified'}
  Physical/Description: ${metadata?.physicalDescription ?? t.description ?? `${t.name} (use your knowledge of this person)`}
  Clothing: ${metadata?.standardClothing ?? 'unspecified'}
  Distinguishing features: ${metadata?.distinguishingFeatures ?? 'unspecified'}`;
    })
    .join('\n\n');

  const numTalent = talentList.length;
  const numCharacters = characters.length;
  return {
    charactersDescription,
    talentDescription,
    numTalent: `${numTalent}`,
    numCharacters: `${numCharacters}`,
    expectedMatches: `${Math.min(numTalent, numCharacters)}`,
    additionalRequirements:
      numTalent > numCharacters
        ? `- There are more talent (${numTalent}) than characters (${numCharacters}). Each character still takes ONE talent, so some talent will go unmatched: pick the best fit for each character.`
        : '',
  };
}
