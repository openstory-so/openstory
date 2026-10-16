/**
 * Tests for location prompt building functions
 */

import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import { describe, expect, it } from 'vitest';
import type { LocationBibleEntry } from '@/shots/scene-analysis.schema';
import type { SequenceLocationMinimal } from '@/platform/server/db/schema';
import {
  buildLocationDescription,
  buildLocationReferenceImages,
  buildLocationSheetPrompt,
  buildPromptWithLocationReferences,
} from './location-prompt';

const mockLocationEntry: LocationBibleEntry = {
  locationId: 'loc_001',
  name: 'INT. OFFICE - DAY',
  type: 'interior',
  description:
    'A modern corporate office with glass walls and open floor plan.',
  architecturalStyle: 'Contemporary minimalist',
  keyFeatures: 'Floor-to-ceiling windows, standing desks, plants',
  ambiance: 'Professional, focused, modern',
  rendering: PHOTOREAL_RENDERING,
  consistencyTag: 'office_modern_glass',
  firstMention: {
    sceneId: 'scene_001',
    text: 'The office buzzes with activity',
    lineNumber: 1,
  },
};

const officeLocation: SequenceLocationMinimal = {
  id: 'loc-1',
  locationId: 'loc_001',
  name: 'INT. OFFICE - DAY',
  referenceImageUrl: 'https://example.com/office.png',
  referenceStatus: 'completed',
  description: 'A modern corporate office with glass walls',
  consistencyTag: 'office_modern_glass',
  referenceInputHash: null,
  selectedReferenceVersionId: null,
};

const streetLocation: SequenceLocationMinimal = {
  id: 'loc-2',
  locationId: 'loc_002',
  name: 'EXT. STREET - NIGHT',
  referenceImageUrl: 'https://example.com/street.png',
  referenceStatus: 'completed',
  description: 'A busy city street at night',
  consistencyTag: 'city_street_night',
  referenceInputHash: null,
  selectedReferenceVersionId: null,
};

const apartmentLocation: SequenceLocationMinimal = {
  id: 'loc-3',
  locationId: 'loc_003',
  name: 'INT. APARTMENT - EVENING',
  referenceImageUrl: null,
  referenceStatus: 'pending',
  description: 'A cozy apartment',
  consistencyTag: 'apartment_cozy',
  referenceInputHash: null,
  selectedReferenceVersionId: null,
};

const mockLocations: SequenceLocationMinimal[] = [
  officeLocation,
  streetLocation,
  apartmentLocation,
];

describe('location-prompt', () => {
  describe('buildLocationDescription', () => {
    it('should build description from location name and description', () => {
      const desc = buildLocationDescription(officeLocation);
      expect(desc).toBe(
        'INT. OFFICE - DAY - A modern corporate office with glass walls'
      );
    });

    it('should return just name if no description', () => {
      const location: SequenceLocationMinimal = {
        ...officeLocation,
        description: null,
      };
      const desc = buildLocationDescription(location);
      expect(desc).toBe('INT. OFFICE - DAY');
    });
  });

  describe('buildLocationReferenceImages', () => {
    it('should only include locations with reference images', () => {
      const refs = buildLocationReferenceImages(mockLocations);
      expect(refs).toHaveLength(2);
      const [first, second] = refs;
      if (!first || !second) throw new Error('test setup: refs missing');
      expect(first.referenceImageUrl).toBe('https://example.com/office.png');
      expect(second.referenceImageUrl).toBe('https://example.com/street.png');
    });

    it('should return empty array for locations without images', () => {
      const refs = buildLocationReferenceImages([apartmentLocation]);
      expect(refs).toHaveLength(0);
    });

    it('should include description in reference', () => {
      const refs = buildLocationReferenceImages([officeLocation]);
      const [first] = refs;
      if (!first) throw new Error('test setup: ref missing');
      expect(first.description).toContain('INT. OFFICE');
    });
  });

  describe('buildPromptWithLocationReferences', () => {
    it('should combine prompt with location references', () => {
      const basePrompt = 'A wide shot of an office interior';
      const result = buildPromptWithLocationReferences(
        basePrompt,
        mockLocations
      );

      expect(result.prompt).toContain(basePrompt);
      expect(result.referenceUrls).toHaveLength(2);
      expect(result.referenceUrls).toContain('https://example.com/office.png');
    });

    it('should return original prompt if no locations have images', () => {
      const basePrompt = 'A wide shot of an apartment';
      const result = buildPromptWithLocationReferences(basePrompt, [
        apartmentLocation,
      ]);

      expect(result.prompt).toBe(basePrompt);
      expect(result.referenceUrls).toHaveLength(0);
    });
  });

  describe('buildLocationSheetPrompt rendering', () => {
    const animated: LocationBibleEntry = {
      ...mockLocationEntry,
      rendering: '3D animated, Pixar-like',
    };

    it('photoreal adds no rendering section', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry, []);
      expect(result.prompt).not.toContain('[RENDERING]');
      expect(result.prompt).not.toContain(PHOTOREAL_RENDERING);
    });

    it('another rendering is named', () => {
      const result = buildLocationSheetPrompt(animated, []);
      expect(result.prompt).toContain('[RENDERING]');
      expect(result.prompt).toContain(
        'Render this location as 3D animated, Pixar-like.'
      );
    });

    it('takes nothing else from a style', () => {
      const result = buildLocationSheetPrompt(animated, []);
      expect(result.prompt).not.toContain('[STYLE DIRECTION]');
      expect(result.prompt).not.toContain('[COLOR PALETTE]');
    });

    it('keeps the location-specific attributes', () => {
      const result = buildLocationSheetPrompt(animated, []);
      expect(result.prompt).toContain('Contemporary minimalist');
      expect(result.prompt).toContain('Floor-to-ceiling windows');
      expect(result.prompt).toContain('[GRID LAYOUT');
    });
  });

  describe('buildLocationSheetPrompt', () => {
    it('should build a prompt for location reference generation', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry, []);

      expect(result.prompt).toContain('INT. OFFICE');
      expect(result.prompt).toContain('Interior');
      expect(result.prompt).toContain('Contemporary minimalist');
      expect(result.prompt).toContain('Floor-to-ceiling windows');
      expect(result.referenceUrls).toHaveLength(0);
      expect(result.prompt).not.toContain('Reference Images');
    });

    it('photos produce the reference instruction and are sent in order', () => {
      const photos = [
        'https://example.com/photo-a.png',
        'https://example.com/photo-b.png',
      ];
      const result = buildLocationSheetPrompt(mockLocationEntry, photos);

      expect(result.prompt).toContain('IMPORTANT - Reference Images:');
      expect(result.prompt).toContain(
        "Use the provided reference images as the definitive source for this location's appearance."
      );
      expect(result.referenceUrls).toEqual(photos);
      // The bible still describes the place: photos do not replace it.
      expect(result.prompt).toContain('A modern corporate office');
    });

    it('a place with photos and no description is drawn from the photos', () => {
      const result = buildLocationSheetPrompt(
        { ...mockLocationEntry, description: '' },
        ['https://example.com/photo-a.png']
      );
      expect(result.prompt).toContain('Derive from the references');
    });

    it('renders the place in neutral light without a time-of-day label', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry, []);
      expect(result.prompt).toContain('Neutral, even light');
      expect(result.prompt).not.toContain('DAY - DAY');
      expect(result.prompt).not.toContain('[COLOR PALETTE]');
    });

    it('should handle exterior locations', () => {
      const exteriorEntry: LocationBibleEntry = {
        ...mockLocationEntry,
        type: 'exterior',
        name: 'EXT. PARK - AFTERNOON',
      };
      const result = buildLocationSheetPrompt(exteriorEntry, []);
      expect(result.prompt).toContain('Exterior');
    });
  });
});
