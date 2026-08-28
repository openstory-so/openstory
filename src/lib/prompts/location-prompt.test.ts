/**
 * Tests for location prompt building functions
 */

import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { describe, expect, it } from 'vitest';
import type { LocationBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { SequenceLocationMinimal, StyleConfig } from '@/lib/db/schema';
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
  timeOfDay: 'day',
  description:
    'A modern corporate office with glass walls and open floor plan.',
  architecturalStyle: 'Contemporary minimalist',
  keyFeatures: 'Floor-to-ceiling windows, standing desks, plants',
  colorPalette: 'Neutral grays, whites, green accents from plants',
  lightingSetup: 'Natural daylight streaming through windows',
  ambiance: 'Professional, focused, modern',
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

  describe('buildLocationSheetPrompt with styleConfig', () => {
    const animatedStyle: StyleConfig = migrateStyleConfigV1ToV2({
      mood: 'Whimsical, playful, and colorful',
      artStyle:
        'Stylized 3D animation with exaggerated proportions and rich textures.',
      lighting:
        'Soft global illumination with warm key lights and cool fill. Bounced light creates depth.',
      colorPalette: ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'],
      cameraWork:
        'Smooth dollies and gentle crane movements. Wide establishing shots with shallow depth of field on details.',
      referenceFilms: [
        'heartfelt balloon-house adventure animation',
        'gourmet rat-chef kitchen animation',
        'vibrant land-of-the-dead family animation',
      ],
      colorGrading:
        'Saturated and warm with a slight bloom. Shadows are never pure black.',
    });

    it('without styleConfig produces no style direction section', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry);
      expect(result.prompt).not.toContain('[STYLE DIRECTION]');
    });

    it('with styleConfig includes style direction section', () => {
      const result = buildLocationSheetPrompt(
        mockLocationEntry,
        undefined,
        animatedStyle
      );

      expect(result.prompt).toContain('[STYLE DIRECTION]');
      expect(result.prompt).toContain('Stylized 3D animation');
      expect(result.prompt).toContain('Whimsical, playful');
      expect(result.prompt).toContain('heartfelt balloon-house adventure');
    });

    it('with styleConfig preserves location-specific attributes', () => {
      const result = buildLocationSheetPrompt(
        mockLocationEntry,
        undefined,
        animatedStyle
      );

      expect(result.prompt).toContain('Contemporary minimalist');
      expect(result.prompt).toContain('Floor-to-ceiling windows');
      expect(result.prompt).toContain('[GRID LAYOUT');
    });

    it('with styleConfig and library overrides composes correctly', () => {
      const result = buildLocationSheetPrompt(
        mockLocationEntry,
        {
          description: 'A sleek tech startup',
          referenceImageUrl: 'https://example.com/lib.png',
        },
        animatedStyle
      );

      expect(result.prompt).toContain('[STYLE DIRECTION]');
      expect(result.prompt).toContain('Stylized 3D animation');
      expect(result.prompt).toContain('A sleek tech startup');
      expect(result.referenceUrls).toContain('https://example.com/lib.png');
    });
  });

  describe('buildLocationSheetPrompt', () => {
    it('should build a prompt for location reference generation', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry);

      expect(result.prompt).toContain('INT. OFFICE');
      expect(result.prompt).toContain('Interior');
      expect(result.prompt).toContain('Contemporary minimalist');
      expect(result.prompt).toContain('Floor-to-ceiling windows');
      expect(result.referenceUrls).toHaveLength(0);
    });

    it('should include library overrides when provided', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry, {
        description: 'A sleek tech startup office',
        referenceImageUrl: 'https://example.com/library-office.png',
      });

      expect(result.prompt).toContain('A sleek tech startup office');
      expect(result.referenceUrls).toHaveLength(1);
      expect(result.referenceUrls[0]).toBe(
        'https://example.com/library-office.png'
      );
    });

    it('should include time of day in prompt', () => {
      const result = buildLocationSheetPrompt(mockLocationEntry);
      expect(result.prompt).toContain('DAY');
    });

    it('should handle exterior locations', () => {
      const exteriorEntry: LocationBibleEntry = {
        ...mockLocationEntry,
        type: 'exterior',
        name: 'EXT. PARK - AFTERNOON',
      };
      const result = buildLocationSheetPrompt(exteriorEntry);
      expect(result.prompt).toContain('Exterior');
    });
  });
});
