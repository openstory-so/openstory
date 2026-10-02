import type { LocationBibleEntry } from '@/shots/scene-analysis.schema';
import type { LibraryLocation } from '@/platform/server/db/schema';

/**
 * Build prompt variables for the location matching prompt.
 * Used by the analyze-script workflow with durableLLMCall.
 */
export function buildLocationMatchingPromptVariables(
  locations: LocationBibleEntry[],
  libraryLocations: LibraryLocation[]
) {
  const locationsDescription = locations
    .map(
      (loc) => `- Location ID: ${loc.locationId}
  Name: ${loc.name}
  Type: ${loc.type}
  Description: ${loc.description}
  Architectural Style: ${loc.architecturalStyle}
  Key Features: ${loc.keyFeatures}
  Ambiance: ${loc.ambiance}`
    )
    .join('\n\n');

  const libraryDescription = libraryLocations
    .map(
      (lib) => `- Library Location ID: ${lib.id}
  Name: ${lib.name}
  Description: ${lib.description ?? 'no description'}
  Has Reference Image: ${lib.referenceImageUrl ? 'yes' : 'no'}`
    )
    .join('\n\n');

  const numLibrary = libraryLocations.length;
  const numLocations = locations.length;
  const expectedMatches = Math.min(numLibrary, numLocations);

  return {
    locationsDescription,
    libraryDescription,
    numLibrary: `${numLibrary}`,
    numLocations: `${numLocations}`,
    expectedMatches: `${expectedMatches}`,
    additionalRequirements:
      numLibrary > numLocations
        ? `- Note: More library locations than extracted locations. Match the ${numLocations} best fits.`
        : numLibrary < numLocations
          ? `- Note: More extracted locations than library locations. Some locations will remain unmatched.`
          : '',
  };
}
