/**
 * Tests for sequence locations helper functions
 */

import { describe, expect, it } from 'vitest';
import { matchLocationsToScene } from '@/lib/workflows/scene-matching';
import type { SequenceLocationWithReference } from '@/lib/db/schema';

// Mock location data - using full SequenceLocation type
const mockLocations: [
  SequenceLocationWithReference,
  SequenceLocationWithReference,
  SequenceLocationWithReference,
] = [
  {
    id: 'loc-1',
    sequenceId: 'seq-1',
    libraryLocationId: null,
    locationId: 'loc_001',
    name: 'INT. OFFICE - DAY',
    type: 'interior',
    timeOfDay: 'day',
    description: 'A modern corporate office with glass walls',
    architecturalStyle: 'modern',
    keyFeatures: 'glass walls, open floor plan',
    colorPalette: 'neutral grays and whites',
    lightingSetup: 'natural light from large windows',
    ambiance: 'professional, corporate',
    consistencyTag: 'office_modern_glass',
    firstMentionSceneId: 'scene_001',
    firstMentionText: 'The office buzzes with activity',
    firstMentionLine: 1,
    referenceImageUrl: 'https://example.com/office.png',
    referenceImagePath: 'locations/office.png',
    referenceStatus: 'completed',
    referenceGeneratedAt: new Date(),
    referenceError: null,
    referenceInputHash: null,
    selectedReferenceVersionId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'loc-2',
    sequenceId: 'seq-1',
    libraryLocationId: null,
    locationId: 'loc_002',
    name: 'EXT. STREET - NIGHT',
    type: 'exterior',
    timeOfDay: 'night',
    description: 'A busy city street at night',
    architecturalStyle: 'urban',
    keyFeatures: 'streetlights, storefronts',
    colorPalette: 'neon lights, dark shadows',
    lightingSetup: 'artificial streetlights and neon signs',
    ambiance: 'bustling, urban',
    consistencyTag: 'city_street_night',
    firstMentionSceneId: 'scene_002',
    firstMentionText: 'The city comes alive at night',
    firstMentionLine: 5,
    referenceImageUrl: 'https://example.com/street.png',
    referenceImagePath: 'locations/street.png',
    referenceStatus: 'completed',
    referenceGeneratedAt: new Date(),
    referenceError: null,
    referenceInputHash: null,
    selectedReferenceVersionId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'loc-3',
    sequenceId: 'seq-1',
    libraryLocationId: null,
    locationId: 'loc_003',
    name: 'INT. APARTMENT - EVENING',
    type: 'interior',
    timeOfDay: 'evening',
    description: 'A cozy apartment',
    architecturalStyle: 'residential',
    keyFeatures: 'warm lighting, comfortable furniture',
    colorPalette: 'warm tones',
    lightingSetup: 'soft lamp lighting',
    ambiance: 'cozy, intimate',
    consistencyTag: 'apartment_cozy',
    firstMentionSceneId: 'scene_003',
    firstMentionText: 'Home sweet home',
    firstMentionLine: 10,
    referenceImageUrl: null,
    referenceImagePath: null,
    referenceStatus: 'pending',
    referenceGeneratedAt: null,
    referenceError: null,
    referenceInputHash: null,
    selectedReferenceVersionId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// Helper to create a partial mock shot with just the fields needed for matching

describe('matchLocationsToScene', () => {
  it('matches on the scene environment tag', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      'office_modern_glass',
      ''
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('matches on the scene location when there is no environment tag', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      '',
      'INT. OFFICE - DAY'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('matches a street location by tag', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      'city_street_night',
      ''
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-2']);
  });

  it('returns nothing when neither key is set', () => {
    expect(matchLocationsToScene(mockLocations, '', '')).toEqual([]);
  });
});

describe('matchLocationsToScene — prose scripts (no slugline)', () => {
  it('finds the set named in the scene text when tag and slugline are empty', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      '',
      '',
      'Mateo pushes through the office doors at a run.'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('prefers the location whose whole name the text carries', () => {
    // "city street" is both tokens of loc-2's consistency tag; "office" is one
    // of loc-1's. The more specific match wins.
    const matched = matchLocationsToScene(
      mockLocations,
      '',
      '',
      'They meet on the city street outside the office block.'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-2']);
  });

  it('does not scan the text when the tag already matched', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      'office_modern_glass',
      '',
      'A wide shot of the city street.'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('returns nothing when the text names no location', () => {
    expect(
      matchLocationsToScene(mockLocations, '', '', 'Close on her hands.')
    ).toEqual([]);
  });
});
