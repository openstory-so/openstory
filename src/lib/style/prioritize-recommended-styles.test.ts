import {
  catalogueWithoutRecommendations,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import type { StyleRecommendation } from '@/hooks/use-styles';
import type { Style } from '@/types/database';
import { describe, expect, it } from 'vitest';

function makeStyle(id: string): Style {
  return {
    id,
    teamId: 'team-1',
    sequenceId: null,
    name: id,
    description: null,
    config: {
      mood: 'moody',
      artStyle: 'art',
      lighting: 'low',
      colorPalette: [],
      cameraWork: 'static',
      referenceFilms: [],
      colorGrading: 'neutral',
    },
    category: 'cinematic',
    tags: [],
    isPublic: true,
    isTemplate: false,
    version: 1,
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
    createdBy: 'user-1',
  };
}

const recs: StyleRecommendation[] = [
  { styleId: 'c', score: 90, reasoning: 'fits' },
  { styleId: 'a', score: 80, reasoning: 'also fits' },
];

describe('resolveRecommendedStyles', () => {
  const styles = [makeStyle('a'), makeStyle('b'), makeStyle('c')];

  it('returns ranked styles in order', () => {
    expect(
      resolveRecommendedStyles(styles, [
        { styleId: 'c', score: 1, reasoning: '' },
        { styleId: 'a', score: 2, reasoning: '' },
      ]).map((s) => s.id)
    ).toEqual(['c', 'a']);
  });
});

describe('catalogueWithoutRecommendations', () => {
  const styles = [
    makeStyle('a'),
    makeStyle('b'),
    makeStyle('c'),
    makeStyle('d'),
  ];

  it('omits recommended ids from the catalogue tail', () => {
    expect(
      catalogueWithoutRecommendations(styles, recs).map((s) => s.id)
    ).toEqual(['b', 'd']);
  });
});
