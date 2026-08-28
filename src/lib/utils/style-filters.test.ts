import type { Style } from '@/types/database';
import { describe, expect, test } from 'vitest';
import { filterStyles } from './style-filters';

const baseStyle: Style = {
  id: 'fixture-base',
  teamId: 'team-test',
  sequenceId: null,
  name: 'Fixture Base',
  description: 'A base style for fixtures.',
  category: 'cinematic',
  tags: ['cinematic'],
  config: {
    mood: 'test',
    artStyle: 'test',
    lighting: 'test',
    colorPalette: ['#000000'],
    cameraWork: 'test',
    referenceFilms: [],
    colorGrading: 'test',
  },
  isPublic: true,
  isTemplate: true,
  version: null,
  previewUrl: null,
  sampleVideos: [],
  recommendedImageModel: null,
  recommendedVideoModel: null,
  defaultAspectRatio: null,
  useCases: [],
  sortOrder: 0,
  usageCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'system',
};

function makeStyle(overrides: Partial<Style>): Style {
  return { ...baseStyle, ...overrides };
}

const mockStyles: Style[] = [
  makeStyle({
    id: 'cinematic-1',
    name: 'Award Season',
    description: 'Deep emotional storytelling with rich cinematography.',
    category: 'cinematic',
    tags: ['drama', 'emotional', 'cinematic'],
  }),
  makeStyle({
    id: 'animation-1',
    name: 'Animated',
    description:
      'Premium adult-oriented cinematic animation with painterly detail.',
    category: 'animation',
    tags: ['animation', 'cinematic'],
  }),
  makeStyle({
    id: 'animatic-1',
    name: 'Animatic',
    description: 'Rough storyboard pre-visualization aesthetic.',
    category: 'animatic',
    tags: ['animatic', 'storyboard'],
  }),
  makeStyle({
    id: 'documentary-1',
    name: 'Documentary',
    description: 'Natural observational style.',
    category: 'documentary',
    tags: ['documentary', 'realistic'],
  }),
  makeStyle({
    id: 'romance-1',
    name: 'Rom-Com',
    description: 'Bright warm visuals with soft lighting.',
    category: 'romance',
    tags: ['romance', 'lighthearted'],
  }),
  makeStyle({
    id: 'ecommerce-1',
    name: 'Product Ad',
    description: 'Fresh tactile product content for social-first campaigns.',
    category: 'ecommerce',
    tags: ['product', 'ecommerce'],
  }),
];

describe('filterStyles', () => {
  describe('category filtering', () => {
    test('returns all styles when category is "all"', () => {
      const result = filterStyles(mockStyles, 'all', '');
      expect(result).toEqual(mockStyles);
      expect(result.length).toBe(mockStyles.length);
    });

    test('filters by specific category', () => {
      const result = filterStyles(mockStyles, 'cinematic', '');
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Award Season');
    });

    test('filters by "new" category (last 7 days)', () => {
      const result = filterStyles(mockStyles, 'new', '');
      expect(result.length).toBe(mockStyles.length);
    });

    test('returns empty array for non-matching category', () => {
      const result = filterStyles(mockStyles, 'vintage', '');
      expect(result.length).toBe(0);
    });

    test('"specialized" matches every small (<3-style) category', () => {
      // Every fixture category has a single style, so all collapse.
      const result = filterStyles(mockStyles, 'specialized', '');
      expect(result.length).toBe(mockStyles.length);
    });

    test('"specialized" excludes styles in a large category', () => {
      const big = [
        makeStyle({ id: 'b1', category: 'commercial' }),
        makeStyle({ id: 'b2', category: 'commercial' }),
        makeStyle({ id: 'b3', category: 'commercial' }),
        makeStyle({ id: 's1', category: 'travel' }),
      ];
      const result = filterStyles(big, 'specialized', '');
      expect(result.map((s) => s.id)).toEqual(['s1']);
    });
  });

  describe('search query filtering', () => {
    test('returns all styles when search query is empty', () => {
      const result = filterStyles(mockStyles, 'all', '');
      expect(result.length).toBe(mockStyles.length);
    });

    test('returns all styles when search query is whitespace', () => {
      const result = filterStyles(mockStyles, 'all', '   ');
      expect(result.length).toBe(mockStyles.length);
    });

    test('filters by name match (case insensitive)', () => {
      const result = filterStyles(mockStyles, 'all', 'cinematic');
      const names = result.map((s) => s.name);
      expect(names).toContain('Award Season');
      expect(names).toContain('Animated');
    });

    test('filters by description match', () => {
      const result = filterStyles(mockStyles, 'all', 'bright');
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Rom-Com');
    });

    test('filters by category match in search', () => {
      const result = filterStyles(mockStyles, 'all', 'documentary');
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Documentary');
    });

    test('filters by tag match', () => {
      const result = filterStyles(mockStyles, 'all', 'emotional');
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Award Season');
    });

    test('returns multiple matches for common search term', () => {
      const result = filterStyles(mockStyles, 'all', 'cinematic');
      expect(result.length).toBeGreaterThan(1);
    });

    test('handles partial matches', () => {
      const result = filterStyles(mockStyles, 'all', 'anim');
      const names = result.map((s) => s.name);
      expect(names).toContain('Animated');
      expect(names).toContain('Animatic');
    });

    test('returns empty array for non-matching search', () => {
      const result = filterStyles(mockStyles, 'all', 'nonexistent');
      expect(result.length).toBe(0);
    });
  });

  describe('combined category and search filtering', () => {
    test('applies both category and search filters', () => {
      const result = filterStyles(mockStyles, 'ecommerce', 'product');
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Product Ad');
    });

    test('returns empty when category matches but search does not', () => {
      const result = filterStyles(mockStyles, 'cinematic', 'nonexistent');
      expect(result.length).toBe(0);
    });

    test('returns empty when search matches but category does not', () => {
      const result = filterStyles(mockStyles, 'vintage', 'cinematic');
      expect(result.length).toBe(0);
    });

    test('filters new items with search query', () => {
      const result = filterStyles(mockStyles, 'new', 'animat');
      const names = result.map((s) => s.name);
      expect(names).toContain('Animated');
      expect(names).toContain('Animatic');
    });
  });

  describe('edge cases', () => {
    test('handles empty styles array', () => {
      const result = filterStyles([], 'all', '');
      expect(result.length).toBe(0);
    });

    test('handles null description', () => {
      const stylesWithNullDesc: Style[] = [makeStyle({ description: null })];
      const result = filterStyles(stylesWithNullDesc, 'all', 'test');
      expect(result.length).toBe(0);
    });

    test('handles null category', () => {
      const stylesWithNullCategory: Style[] = [makeStyle({ category: null })];
      const result = filterStyles(stylesWithNullCategory, 'cinematic', '');
      expect(result.length).toBe(0);
    });

    test('handles empty tags array', () => {
      const stylesWithEmptyTags: Style[] = [
        makeStyle({
          name: 'Test Style',
          description: 'A test style',
          category: 'test',
          tags: [],
        }),
      ];
      const result = filterStyles(stylesWithEmptyTags, 'all', 'moody');
      expect(result.length).toBe(0);
    });

    test('handles null tags array', () => {
      const stylesWithNullTags: Style[] = [
        makeStyle({
          name: 'Test Style',
          description: 'A test style',
          category: 'test',
          tags: null,
        }),
      ];
      const result = filterStyles(stylesWithNullTags, 'all', 'moody');
      expect(result.length).toBe(0);
    });
  });
});
