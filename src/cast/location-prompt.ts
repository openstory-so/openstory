/**
 * Location Prompt Builder
 *
 * Handles location-related prompt building for location reference sheets
 * and reference image integration in frame generation.
 *
 * @module lib/prompts/location-prompt
 */

import type { LocationBibleEntry } from '@/shots/scene-analysis.schema';
import type { SequenceLocationMinimal } from '@/platform/server/db/schema';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import {
  type PromptWithReferenceImages,
  type ReferenceImageDescription,
  buildReferenceImagePrompt,
} from '@/stills/reference-image-prompt';
import { referenceProvenanceKey } from '@/motion/reference-provenance';

/**
 * Build a concise location description from location data
 *
 * @param location - Location with flattened fields
 * @returns Concise description string
 */
export const buildLocationDescription = (
  location: SequenceLocationMinimal
): string => {
  const parts: string[] = [];

  if (location.description) {
    const descSummary = location.description.split(/[.,]/)[0]?.trim() ?? '';
    if (descSummary.length > 0 && descSummary.length < 100) {
      parts.push(descSummary);
    }
  }

  return `${location.name}${parts.length > 0 ? ` - ${parts.join(', ')}` : ''}`;
};

/**
 * Build reference images for locations
 * @param locations - Array of locations
 * @returns Array of reference images
 */
export const buildLocationReferenceImages = (
  locations: SequenceLocationMinimal[]
): ReferenceImageDescription[] => {
  return locations
    .filter((l) => l.referenceImageUrl)
    .sort((a, b) =>
      a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0
    )
    .map((l) => ({
      referenceImageUrl: l.referenceImageUrl ?? '',
      description: buildLocationDescription(l),
      role: 'location' as const,
      // The bible id prompts name the set by (`metropolitan_sidewalk_corner`),
      // so it gets swapped for its `@ImageN` tag like a character's name.
      token: l.locationId,
      provenanceKey: referenceProvenanceKey(
        'location',
        l.id,
        l.selectedReferenceVersionId ?? l.referenceImageUrl
      ),
    }));
};

/**
 * Build prompt with location reference mapping
 *
 * Enhances the base prompt with location reference information for models
 * that support reference images via the `image_urls` parameter.
 *
 * @param basePrompt - The original visual prompt
 * @param locations - Array of sequence locations with completed reference images
 * @returns Enhanced prompt and array of reference URLs
 */
export const buildPromptWithLocationReferences = (
  basePrompt: string,
  locations: SequenceLocationMinimal[]
): PromptWithReferenceImages => {
  return buildReferenceImagePrompt(
    basePrompt,
    buildLocationReferenceImages(locations)
  );
};

/**
 * What the place is rendered as (#1695), the one thing a sheet takes from a
 * style. Photoreal says nothing, so the prompt reads as it always has; the
 * sequence's palette, grade and mood never reach a sheet: they apply at the
 * shot.
 */
const renderingSection = (rendering: string): string =>
  rendering === PHOTOREAL_RENDERING
    ? ''
    : `
[RENDERING]:
Render this location as ${rendering}. All 9 panels must be rendered the same way.
`;

/**
 * Build a location reference sheet prompt structure
 *
 * Creates a 3x3 grid of 16:9 images showing different angles and views:
 * - Row 1: Wide establishing shots (exterior/approach, main view, alternate angle)
 * - Row 2: Medium shots (key areas and features)
 * - Row 3: Detail shots (architectural details, textures, atmosphere)
 *
 * @param entry - The location's bible
 * @param referencePhotoUrls - The photos uploaded as input; `[]` draws the
 *   place from the bible alone
 * @returns Complete prompt string and reference URLs
 */
export const buildLocationSheetPrompt = (
  entry: LocationBibleEntry,
  referencePhotoUrls: readonly string[]
): { prompt: string; referenceUrls: string[] } => {
  const referenceUrls = [...referencePhotoUrls];

  // Build the prompt sections
  const typeLabel =
    entry.type === 'interior'
      ? 'Interior'
      : entry.type === 'exterior'
        ? 'Exterior'
        : 'Interior/Exterior';

  const referenceInstruction =
    referenceUrls.length > 0
      ? `
IMPORTANT - Reference Images:
Use the provided reference images as the definitive source for this location's appearance.
Match all visual details exactly: architecture, materials, surface colors, and distinctive features. Use neutral, even lighting.
Every panel must be visually consistent with the references while showing different angles and areas.
`
      : '';

  const prompt =
    `A professional 3x3 grid location reference sheet for film production, showing 9 distinct views of the same location in consistent visual style.

[LOCATION]:
${entry.name}
Type: ${typeLabel}

[VISUAL DESCRIPTION]:
${entry.description || (referenceUrls.length > 0 ? 'Derive from the references' : '')}

[ARCHITECTURAL STYLE]:
${entry.architecturalStyle || 'Derive from description and references'}

[KEY FEATURES]:
${entry.keyFeatures || 'Key visual elements that define this space'}

[LIGHTING]:
Neutral, even light across all panels. Show the place independently of time of day. Preserve material and surface colours; practical light fixtures are fixed features, not scene lighting.

[ATMOSPHERE]:
${entry.ambiance || 'Derive from description and setting'}
${referenceInstruction}${renderingSection(entry.rendering)}
[GRID LAYOUT - 3 rows × 3 columns, each panel 16:9 aspect ratio]:

Row 1 - ESTABLISHING SHOTS:
- Panel 1 (Top-Left): Wide exterior/approach view showing the location in context
- Panel 2 (Top-Center): Main establishing shot - the primary view of the location
- Panel 3 (Top-Right): Alternate angle establishing shot

Row 2 - MEDIUM SHOTS:
- Panel 4 (Middle-Left): Key interior/exterior area view
- Panel 5 (Middle-Center): Central focal point of the location
- Panel 6 (Middle-Right): Secondary important area

Row 3 - DETAIL & ATMOSPHERE:
- Panel 7 (Bottom-Left): Architectural or design details close-up
- Panel 8 (Bottom-Center): Texture and material details
- Panel 9 (Bottom-Right): Atmospheric/mood shot capturing the essence

[TECHNICAL SPECIFICATIONS]:
- All 9 panels must show the SAME location from different angles
- Maintain absolute visual consistency across all panels (architecture, colors, materials, lighting)
- Each panel is 16:9 landscape format
- Cinematic film production quality
- High resolution with rich detail
- No people or characters in any frame
- Clean grid layout with thin dividing lines

Style: Professional film location reference sheet, production design documentation.
Output: Single image containing 3×3 grid of location views.`.trim();

  return { prompt, referenceUrls };
};
