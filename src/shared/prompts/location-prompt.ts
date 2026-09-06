/**
 * Location Prompt Builder
 *
 * Handles location-related prompt building for location reference sheets
 * and reference image integration in frame generation.
 *
 * @module lib/prompts/location-prompt
 */

import type { LocationBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { SequenceLocationMinimal, StyleConfig } from '@/lib/db/schema';
import {
  type PromptWithReferenceImages,
  type ReferenceImageDescription,
  buildReferenceImagePrompt,
} from './reference-image-prompt';

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
    .map((l) => ({
      referenceImageUrl: l.referenceImageUrl ?? '',
      description: buildLocationDescription(l),
      role: 'location' as const,
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
 * Format a style direction section for location reference sheets.
 * Overlays the sequence's visual style on top of the location-specific attributes.
 */
const formatStyleDirectionForLocation = (styleConfig: StyleConfig): string => {
  const { look, motion, references } = styleConfig;
  const colorPaletteStr = look.colorPalette.join(', ');
  const referencesStr =
    references.length > 0 ? `\nReference look: ${references.join(', ')}.` : '';
  return `
[STYLE DIRECTION]:
Render this location in the following visual style:
Art style: ${look.artStyle}
Mood: ${look.mood}
Lighting direction: ${look.lighting}
Color palette: ${colorPaletteStr}
Color grading: ${look.colorGrading}
Camera approach: ${motion.camera}${referencesStr}
All 9 panels must consistently reflect this style direction.`;
};

/**
 * Build a location reference sheet prompt structure
 *
 * Creates a 3x3 grid of 16:9 images showing different angles and views:
 * - Row 1: Wide establishing shots (exterior/approach, main view, alternate angle)
 * - Row 2: Medium shots (key areas and features)
 * - Row 3: Detail shots (architectural details, textures, atmosphere)
 *
 * @param entry - The location bible entry from script analysis
 * @param libraryLocationOverrides - Optional library location data for overrides
 * @param styleConfig - Optional sequence style to apply to the location sheet
 * @returns Complete prompt string and reference URLs
 */
export const buildLocationSheetPrompt = (
  entry: LocationBibleEntry,
  libraryLocationOverrides?: {
    description?: string;
    referenceImageUrl?: string;
  },
  styleConfig?: StyleConfig
): { prompt: string; referenceUrls: string[] } => {
  const referenceUrls: string[] = [];
  if (libraryLocationOverrides?.referenceImageUrl) {
    referenceUrls.push(libraryLocationOverrides.referenceImageUrl);
  }

  // Use override description if provided, otherwise use entry description
  const description =
    libraryLocationOverrides?.description || entry.description || '';

  // Build the prompt sections
  const typeLabel =
    entry.type === 'interior'
      ? 'Interior'
      : entry.type === 'exterior'
        ? 'Exterior'
        : 'Interior/Exterior';

  const timeOfDayLabel = entry.timeOfDay
    ? ` - ${entry.timeOfDay.toUpperCase()}`
    : '';

  // Build reference instruction if we have library images
  let referenceInstruction = '';
  if (referenceUrls.length > 0) {
    referenceInstruction = `
IMPORTANT - Reference Images:
Use the provided reference images as the definitive source for this location's appearance.
Match all visual details exactly: architecture, materials, colors, lighting atmosphere, and distinctive features.
Every panel must be visually consistent with the references while showing different angles and areas.
`;
  }

  const prompt =
    `A professional 3x3 grid location reference sheet for film production, showing 9 distinct views of the same location in consistent visual style.

[LOCATION]:
${entry.name}${timeOfDayLabel}
Type: ${typeLabel}

[VISUAL DESCRIPTION]:
${description}

[ARCHITECTURAL STYLE]:
${entry.architecturalStyle || 'Derive from description and references'}

[KEY FEATURES]:
${entry.keyFeatures || 'Key visual elements that define this space'}

[COLOR PALETTE]:
${entry.colorPalette || 'Derive from description and mood'}

[LIGHTING]:
${entry.lightingSetup || 'Match time of day and mood - consistent across all panels'}

[ATMOSPHERE]:
${entry.ambiance || 'Derive from description and setting'}
${referenceInstruction}${styleConfig ? formatStyleDirectionForLocation(styleConfig) : ''}
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

/**
 * Build a library location sheet prompt from user-provided reference images
 *
 * Similar to buildLocationSheetPrompt but designed for library locations
 * where the reference images ARE the source of truth (not script analysis).
 *
 * @param name - Location name
 * @param description - Optional location description
 * @param referenceImageUrls - Array of reference image URLs
 * @returns Complete prompt string and reference URLs
 */
export const buildLibraryLocationSheetPrompt = (
  name: string,
  description?: string,
  referenceImageUrls?: string[]
): { prompt: string; referenceUrls: string[] } => {
  const referenceUrls = referenceImageUrls ?? [];

  const descSection = description
    ? `\n[LOCATION DESCRIPTION]:\n${description}`
    : '';

  const referenceInstruction =
    referenceUrls.length > 0
      ? `
IMPORTANT - Reference Images:
The provided reference images are the DEFINITIVE source for this location's appearance.
Analyze the references to understand:
- Architectural style and design elements
- Color palette and materials
- Lighting conditions and atmosphere
- Key distinctive features
Generate 9 different views that all clearly depict the SAME location shown in the references.
`
      : `
Generate a realistic, detailed location based on the name and description.
Create 9 consistent views showing different angles of this location.
`;

  const prompt =
    `A professional 3x3 grid location reference sheet for film production, showing 9 distinct views of the same location in consistent visual style.

[LOCATION]:
${name}
${descSection}
${referenceInstruction}
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

/**
 * Build a prompt for generating a location thumbnail/preview.
 * Used as the location's library preview image.
 */
export const buildLocationPreviewPrompt = (
  name: string,
  description?: string,
  hasReferenceImages?: boolean
): string => {
  const descSection = description ? `\nLocation notes: ${description}` : '';
  const referenceSection = hasReferenceImages
    ? `IMPORTANT: Use the provided reference images as the definitive source for this location's appearance.
Match all visual details exactly: architecture, colors, lighting, and atmosphere.`
    : `IMPORTANT: Generate a realistic location based on the name and description provided.
Create a detailed, consistent environment that matches the description.`;

  return `Cinematic establishing shot of ${name}, photorealistic, film production quality.

${referenceSection}

Requirements:
- Wide establishing shot showing the full environment
- Cinematic 16:9 composition
- Rich detail and depth
- Film-like lighting and color grading
- No people in frame
- Clear architectural/environmental features
${descSection}

Style: Cinematic location photography, film production reference.
Aspect ratio: 16:9 landscape format.`;
};
