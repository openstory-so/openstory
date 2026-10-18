/**
 * Character Service
 *
 * Handles character-related business logic for sequence characters,
 * character sheet generation, and reference image prompt building.
 *
 * @module lib/services/character.service
 */

import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';

import type { CharacterMinimal } from '@/platform/server/db/schema';
import { referenceProvenanceKey } from '@/motion/reference-provenance';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';
/**
 * Build a concise character description from character data
 *
 * @param character - Character with flattened fields
 * @returns Concise description string
 */
const buildCharacterDescription = (character: CharacterMinimal): string => {
  const parts: string[] = [];

  if (character.physicalDescription) {
    const physicalSummary =
      character.physicalDescription.split(/[.,]/)[0]?.trim() ?? '';
    if (physicalSummary.length > 0 && physicalSummary.length < 80) {
      parts.push(physicalSummary);
    }
  }

  return `${character.name}${parts.length > 0 ? ` - ${parts.join(', ')}` : ''}`;
};
/**
 * Build reference images for characters
 * @param characters - Array of characters
 * @returns Array of reference images
 * @example
 * ```ts
 * const referenceImages = buildCharacterReferenceImages([jackCharacter, sarahCharacter]);
 * // referenceImages = [jackReferenceImage, sarahReferenceImage]
 * ```
 */
export const buildCharacterReferenceImages = (
  characters: CharacterMinimal[]
): ReferenceImageDescription[] => {
  // A voice-only character has no face to anchor (#1585); a sheet left over
  // from before it was reclassified must not ride along as a reference.
  return characters
    .filter((c) => c.sheetImageUrl && !c.voiceOnly)
    .sort((a, b) =>
      a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0
    )
    .map((c) => ({
      referenceImageUrl: c.sheetImageUrl ?? '',
      description: buildCharacterDescription(c),
      role: 'character' as const,
      token: c.name,
      isPerson: c.isPerson,
      provenanceKey: referenceProvenanceKey(
        'character',
        c.id,
        c.selectedSheetVersionId ?? c.sheetImageUrl
      ),
    }));
};

/**
 * The environment, optical and lighting sections for what the character is
 * rendered as (#2017). Photoreal keeps the commercial reference photography
 * wording photoreal character sheets were recorded with; anything else is the same
 * neutral studio with the rendering named. The sequence's palette, grade and
 * mood never reach a sheet: they apply at the shot.
 */
const renderingSections = (
  rendering: string
): { environment: string; opticalSpecs: string; lighting: string } => {
  const lighting =
    'Neutral, even, high-key studio lighting. Diffused illumination from large softboxes to eliminate harsh shadows and highlight shape and form evenly. 5500K daylight balance.';
  if (rendering === PHOTOREAL_RENDERING) {
    return {
      environment:
        'Seamless, minimalist commercial photo studio cyclorama with flat neutral white background. Clean, sterile, analytical atmosphere designed for clarity.',
      opticalSpecs:
        'Commercial reference photography style. High-resolution medium format digital, tack-sharp focus across all panels, deep depth of field. Flat perspective, no lens distortion.',
      lighting,
    };
  }
  return {
    environment: `Render the character as ${rendering}. Seamless, minimalist studio cyclorama with a flat neutral white background and no environmental detail. Clean, analytical atmosphere designed for clarity: all visual interest comes from the character, not the environment.`,
    opticalSpecs: `${rendering} rendering. Tack-sharp focus and consistent character detail across all panels, deep depth of field. Flat perspective, no lens distortion.`,
    lighting,
  };
};

/**
 * Build the base 4-panel reference sheet prompt structure
 *
 * Creates a consistent prompt with:
 * - 4-panel horizontal layout (frontal, portrait, side, rear)
 * - Style-derived or default studio environment, lighting, and optical specs
 * - Hyper-accurate materiality
 *
 * @param identitySection - The identity section of the prompt
 * @param additionalInstructions - Optional additional instructions (e.g., reference image handling)
 * @param rendering - What the subject is rendered as (#2017); photoreal by default
 * @returns Complete prompt string
 */
const buildBaseSheetPrompt = (
  identitySection: string,
  /** Optional additional instructions (e.g., reference image handling) */
  additionalInstructions: string = '',
  rendering: string = PHOTOREAL_RENDERING
): string => {
  const {
    environment: environmentSection,
    opticalSpecs: opticalSection,
    lighting: lightingSection,
  } = renderingSections(rendering);

  return `A professional four-panel photographic character reference grid, maintaining absolute anatomical and stylistic consistency.

[LAYOUT]:
The grid comprises four distinct, technical views arranged horizontally:
- Panel 1 (Left): Full body frontal view, standing in a neutral pose
- Panel 2 (Center-Left): Close-up portrait frontal view (chest up)
- Panel 3 (Center-Right): Full body side profile view facing left
- Panel 4 (Right): Full body rear view

All attire, accessories, hair, and features must be perfectly consistent across all four panels.

${identitySection}
${additionalInstructions}
[ENVIRONMENT]:
${environmentSection}

[OPTICAL & CAMERA SPECS]:
${opticalSection}

[LIGHTING]:
${lightingSection}

[MATERIALITY]:
Hyper-accurate rendering of all fabrics, skin textures, hardware, and micro-details. Consistent texture rendering across all four angles without beautification or alteration.`.trim();
};

/** Stands in for a reference image when a prompt has no other description. */
export const REFERENCE_LIKENESS_INSTRUCTION =
  "Match the appearance of the person shown in this character's reference image exactly.";

/**
 * Result of building a character sheet prompt
 */
type CharacterSheetPromptResult = {
  /** The generated prompt text */
  prompt: string;
  /** Reference image URLs. The default look's sheet, when this look is drawn from it. */
  referenceUrls: string[];
};

/**
 * Build a detailed character sheet prompt from a character bible entry.
 *
 * Creates a 4-panel horizontal reference grid:
 * - Panel 1: Full body frontal view
 * - Panel 2: Close-up portrait (chest up)
 * - Panel 3: Full body side profile (left)
 * - Panel 4: Full body rear view
 *
 * @param entry - The character bible entry
 * @param styling - The look's hair / makeup / injury notes (#2015), as
 *   `effectiveStyling` resolves them: on the default look they hold what the
 *   bible called distinguishing features (#2065). Null when the look has
 *   none. `entry.standardClothing` is the look's clothing.
 * @param faceSheetUrl - The default look's completed sheet. When set, it is
 *   the only reference: this look keeps that person and changes the costume.
 * @returns Prompt and reference URLs for image generation
 */
export const buildCharacterSheetPrompt = (
  entry: CharacterBibleEntry,
  styling: string | null,
  faceSheetUrl: string | null
): CharacterSheetPromptResult => {
  // A look other than the default is this person in another outfit.
  const fromDefaultLook = Boolean(faceSheetUrl);

  const referenceUrls: string[] = [];
  if (fromDefaultLook && faceSheetUrl) {
    referenceUrls.push(faceSheetUrl);
  }

  const age = entry.age;
  const gender = entry.gender;
  const ethnicity = entry.ethnicity;
  const physicalDescription = entry.physicalDescription;
  const standardClothing = entry.standardClothing;

  // One styling section (#2065): the look's effective styling, which on the
  // default look holds what the bible called distinguishing features. The
  // headings are the ones the two old sections had, kept word for word: the
  // recorded e2e image fixtures match on the whole prompt.
  const notes = styling?.trim() ?? '';
  let stylingSection = '';
  if (notes && fromDefaultLook) {
    stylingSection = `Hair, Makeup & Condition for this look:\n${notes}`;
  } else if (notes) {
    stylingSection = `Distinguishing Features:\n${notes}`;
  }

  const ageStr = age ? `Age: ${age}` : '';

  const genderLine = gender ? `Gender: ${gender}` : '';
  const ethnicityLine = ethnicity ? `Ethnicity: ${ethnicity}` : '';

  let referenceInstruction = '';
  if (fromDefaultLook) {
    referenceInstruction = `
CRITICAL - Same person, new outfit:
The reference image is this character's default look. Every panel must show that same person: face, body, skin, and hair match the reference. Change the costume to the clothing described above. Change the hair only when the styling notes for this look say to. For face, body, skin and hair, the IMAGE takes priority over any text. For the clothing, the TEXT takes priority over the image: the reference wears another outfit.
`;
  }

  const identitySection = `[CHARACTER IDENTITY]:
Name: ${entry.name}
${[ageStr, genderLine, ethnicityLine].filter(Boolean).join('\n')}

Physical Appearance:
${physicalDescription}

Costume:
${standardClothing}

${stylingSection}`.trim();

  // What the character is rendered as (#2017): its own, never the sequence's.
  const prompt = buildBaseSheetPrompt(
    identitySection,
    referenceInstruction,
    entry.rendering
  );

  return { prompt, referenceUrls };
};
