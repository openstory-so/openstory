import { describe, expect, it } from 'vitest';
import type { Style } from '@/types/database';
import {
  groupStylesByCategory,
  styleCanonicalVideoUrl,
  styleCategoryGroupKey,
  styleCategoryLabel,
  styleHoverVideoUrl,
  stylePreviewImageUrls,
  stylePreviewSceneNames,
} from './style-assets';

function makeStyle(overrides: Partial<Style> = {}): Style {
  return {
    id: 'style_1',
    teamId: 'team_1',
    sequenceId: null,
    name: 'Product Ad',
    description: 'A polished product spot.',
    config: {
      mood: 'premium',
      artStyle: 'clean',
      lighting: 'soft',
      colorPalette: ['#000000', '#FFFFFF'],
      cameraWork: 'slow push',
      referenceFilms: [],
      colorGrading: 'neutral',
    },
    category: 'commercial',
    tags: [],
    isPublic: true,
    isTemplate: true,
    previewUrl: 'https://assets.openstory.so/styles/product-ad/thumbnail.webp',
    sampleVideos: [],
    recommendedImageModel: null,
    recommendedVideoModel: null,
    defaultAspectRatio: null,
    useCases: [],
    sortOrder: 0,
    usageCount: 0,
    version: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: null,
    ...overrides,
  };
}

describe('styleHoverVideoUrl', () => {
  it('swaps the thumbnail filename for hover.mp4', () => {
    expect(styleHoverVideoUrl(makeStyle())).toBe(
      'https://assets.openstory.so/styles/product-ad/hover.mp4'
    );
  });

  it('returns null when previewUrl is missing or not a thumbnail', () => {
    expect(styleHoverVideoUrl(makeStyle({ previewUrl: null }))).toBeNull();
    expect(
      styleHoverVideoUrl(
        makeStyle({ previewUrl: 'https://example.com/custom.png' })
      )
    ).toBeNull();
  });
});

describe('styleCanonicalVideoUrl', () => {
  it('prefers the persisted sampleVideos canonical entry', () => {
    const style = makeStyle({
      sampleVideos: [
        {
          url: 'https://cdn.example.com/explicit/canonical.mp4',
          kind: 'canonical',
          label: 'Sample',
          durationSeconds: 5,
          order: 0,
        },
      ],
    });
    expect(styleCanonicalVideoUrl(style)).toBe(
      'https://cdn.example.com/explicit/canonical.mp4'
    );
  });

  it('falls back to the derived canonical.mp4 path', () => {
    expect(styleCanonicalVideoUrl(makeStyle())).toBe(
      'https://assets.openstory.so/styles/product-ad/canonical.mp4'
    );
  });
});

describe('stylePreviewSceneNames', () => {
  it('uses product scenes for product categories', () => {
    expect(
      stylePreviewSceneNames(makeStyle({ category: 'ecommerce' }))
    ).toEqual(['hero', 'detail', 'context']);
  });

  it('uses product scenes for commercial product use-cases', () => {
    expect(
      stylePreviewSceneNames(
        makeStyle({ category: 'commercial', useCases: ['product'] })
      )
    ).toEqual(['hero', 'detail', 'context']);
  });

  it('uses people scenes for narrative categories', () => {
    expect(stylePreviewSceneNames(makeStyle({ category: 'film' }))).toEqual([
      'character',
      'environment',
      'action',
    ]);
  });
});

describe('stylePreviewImageUrls', () => {
  it('derives three full-res still URLs', () => {
    expect(stylePreviewImageUrls(makeStyle({ category: 'film' }))).toEqual([
      'https://assets.openstory.so/styles/product-ad/character.webp',
      'https://assets.openstory.so/styles/product-ad/environment.webp',
      'https://assets.openstory.so/styles/product-ad/action.webp',
    ]);
  });

  it('returns empty when there is no derivable asset folder', () => {
    expect(stylePreviewImageUrls(makeStyle({ previewUrl: null }))).toEqual([]);
  });
});

describe('styleCategoryLabel', () => {
  it('maps known categories to friendly labels', () => {
    expect(styleCategoryLabel('ecommerce')).toBe('E-commerce');
    expect(styleCategoryLabel('influencer')).toBe('Influencer & UGC');
    expect(styleCategoryLabel('film')).toBe('Film & Cinematic');
  });

  it('title-cases unknown categories and labels missing as Other', () => {
    expect(styleCategoryLabel('experimental')).toBe('Experimental');
    expect(styleCategoryLabel(null)).toBe('Other');
  });
});

// Three styles per category clears the collapse threshold, so the category
// survives as its own group.
function trio(category: string): Style[] {
  return [0, 1, 2].map((i) =>
    makeStyle({ id: `${category}-${i}`, category, name: `${category} ${i}` })
  );
}

describe('groupStylesByCategory', () => {
  it('orders surviving categories alphabetically by label', () => {
    const groups = groupStylesByCategory([
      ...trio('film'), // "Film & Cinematic"
      ...trio('commercial'), // "Commercial"
      ...trio('zebra'), // title-cased "Zebra"
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Commercial',
      'Film & Cinematic',
      'Zebra',
    ]);
  });

  it('collapses small/uncategorized categories into a trailing Specialized group', () => {
    const groups = groupStylesByCategory([
      ...trio('commercial'),
      makeStyle({ id: 'travel', category: 'travel' }),
      makeStyle({ id: 'nonprofit', category: 'nonprofit' }),
      makeStyle({ id: 'uncat', category: null }),
    ]);
    expect(groups.map((g) => g.category)).toEqual([
      'commercial',
      'specialized',
    ]);
    expect(groups[1]?.label).toBe('Specialized');
    expect(groups[1]?.styles).toHaveLength(3);
  });

  it('sorts styles within each group A–Z by name', () => {
    const groups = groupStylesByCategory([
      makeStyle({ id: 'a', category: 'commercial', name: 'Banana' }),
      makeStyle({ id: 'b', category: 'commercial', name: 'Apple' }),
      makeStyle({ id: 'c', category: 'commercial', name: 'Cherry' }),
    ]);
    expect(groups[0]?.styles.map((s) => s.name)).toEqual([
      'Apple',
      'Banana',
      'Cherry',
    ]);
  });
});

describe('styleCategoryGroupKey', () => {
  it('returns the raw category when the family is large enough', () => {
    const catalogue = [...trio('film'), ...trio('ecommerce')];
    expect(
      styleCategoryGroupKey(makeStyle({ category: 'film' }), catalogue)
    ).toBe('film');
  });

  it('collapses small families into Specialized', () => {
    const catalogue = [
      ...trio('film'),
      makeStyle({ id: 'travel', category: 'travel' }),
    ];
    expect(
      styleCategoryGroupKey(
        makeStyle({ id: 'travel', category: 'travel' }),
        catalogue
      )
    ).toBe('specialized');
  });
});
