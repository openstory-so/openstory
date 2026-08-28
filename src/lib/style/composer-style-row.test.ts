import {
  ALL_COMPOSER_STYLE_CATEGORIES,
  composerCategoryHiddenCount,
  composerStyleCategoryOptions,
  defaultComposerStyle,
  styleAfterComposerCategoryChange,
  stylesForComposerCategory,
} from '@/lib/style/composer-style-row';
import type { Style } from '@/types/database';
import { describe, expect, it } from 'vitest';

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

function trio(category: string): Style[] {
  return [0, 1, 2].map((i) =>
    makeStyle({
      id: `${category}-${i}`,
      category,
      name: `${category} ${i}`,
    })
  );
}

describe('composerStyleCategoryOptions', () => {
  it('puts Film & Cinematic first', () => {
    const options = composerStyleCategoryOptions([
      ...trio('tech'),
      ...trio('ecommerce'),
      ...trio('film'),
    ]);
    expect(options[0]).toEqual({
      value: 'film',
      label: 'Film & Cinematic',
    });
    expect(options.map((option) => option.value)).toEqual([
      'film',
      'ecommerce',
      'tech',
    ]);
  });

  it('omits film when the catalogue has none', () => {
    const values = composerStyleCategoryOptions(trio('ecommerce')).map(
      (option) => option.value
    );
    expect(values).toEqual(['ecommerce']);
  });
});

describe('stylesForComposerCategory', () => {
  const styles = [...trio('ecommerce'), ...trio('film')];

  it('keeps catalogue order inside the requested family', () => {
    expect(
      stylesForComposerCategory(styles, 'film').map((style) => style.id)
    ).toEqual(['film-0', 'film-1', 'film-2']);
  });

  it('returns the full list in catalogue order for all', () => {
    expect(
      stylesForComposerCategory(styles, ALL_COMPOSER_STYLE_CATEGORIES).map(
        (style) => style.id
      )
    ).toEqual([
      'ecommerce-0',
      'ecommerce-1',
      'ecommerce-2',
      'film-0',
      'film-1',
      'film-2',
    ]);
  });

  it('uses Specialized for small leftover families', () => {
    const catalogue = [
      ...trio('film'),
      makeStyle({ id: 'travel', category: 'travel', name: 'Travel' }),
    ];
    expect(
      stylesForComposerCategory(catalogue, 'specialized').map(
        (style) => style.id
      )
    ).toEqual(['travel']);
  });
});

describe('defaultComposerStyle', () => {
  const styles = [...trio('ecommerce'), ...trio('film')];

  it('picks the first cinematic style, not the commercial-first catalogue head', () => {
    expect(defaultComposerStyle(styles)?.id).toBe('film-0');
  });

  it('honors an explicit family', () => {
    expect(defaultComposerStyle(styles, 'ecommerce')?.id).toBe('ecommerce-0');
  });

  it('falls back to the catalogue head when the family is empty', () => {
    expect(
      defaultComposerStyle(
        [
          makeStyle({
            id: 'product',
            category: 'ecommerce',
            name: 'Product Ad',
          }),
        ],
        'film'
      )?.id
    ).toBe('product');
  });
});

describe('styleAfterComposerCategoryChange', () => {
  const styles = [...trio('ecommerce'), ...trio('film')];

  it('selects the first style of the new family', () => {
    expect(styleAfterComposerCategoryChange(styles, 'ecommerce')?.id).toBe(
      'ecommerce-0'
    );
  });

  it('does not change the pick when switching to All styles', () => {
    expect(
      styleAfterComposerCategoryChange(styles, ALL_COMPOSER_STYLE_CATEGORIES)
    ).toBeUndefined();
  });
});

describe('composerCategoryHiddenCount', () => {
  const film = [
    makeStyle({ id: 'action', category: 'film', name: 'Action' }),
    makeStyle({ id: 'award', category: 'film', name: 'Award Season' }),
    makeStyle({ id: 'doc', category: 'film', name: 'Documentary' }),
  ];

  it('counts family tiles that are not on the strip', () => {
    expect(composerCategoryHiddenCount(film, ['action'])).toBe(2);
  });

  it('ignores recommended tiles from other families', () => {
    expect(composerCategoryHiddenCount(film, ['product', 'action'])).toBe(2);
  });

  it('is zero when the whole family is visible', () => {
    expect(composerCategoryHiddenCount(film, ['action', 'award', 'doc'])).toBe(
      0
    );
  });
});
