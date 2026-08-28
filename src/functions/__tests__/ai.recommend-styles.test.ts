/**
 * Tests for the pure ranking logic behind `recommendStylesForScriptFn` (#787).
 * The billed LLM call + middleware chain is covered by e2e; here we exercise the
 * compact-catalog builder and the index→styleId post-processor (range guards,
 * dedupe, score sort, popularity tie-break, limit) so a regression — a
 * hallucinated index leaking through, a lost tie-break — fails fast.
 */

import { buildStyleCatalog, rankStyleRecommendations } from '@/functions/ai';
import type { Style } from '@/lib/db/schema/libraries';
import { describe, expect, it } from 'vitest';

function makeStyle(overrides: Partial<Style> & { id: string }): Style {
  return {
    teamId: 'team-1',
    sequenceId: null,
    name: 'Style',
    description: 'A style',
    config: {
      mood: 'moody',
      artStyle: 'photoreal',
      lighting: 'low-key',
      colorPalette: ['#000000', '#ffffff'],
      cameraWork: 'handheld',
      referenceFilms: ['Blade Runner'],
      colorGrading: 'teal-orange',
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
    sortOrder: 100,
    usageCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'user-1',
    ...overrides,
  };
}

describe('buildStyleCatalog', () => {
  it('numbers entries by position and preserves the id order', () => {
    const styles = [
      makeStyle({ id: 'a', name: 'Alpha' }),
      makeStyle({ id: 'b', name: 'Beta' }),
      makeStyle({ id: 'c', name: 'Gamma' }),
    ];

    const { catalog, orderedStyleIds } = buildStyleCatalog(styles);

    expect(orderedStyleIds).toEqual(['a', 'b', 'c']);
    expect(catalog).toContain('[0] Alpha —');
    expect(catalog).toContain('[1] Beta —');
    expect(catalog).toContain('[2] Gamma —');
  });

  it('omits empty refs and a null description without dangling separators', () => {
    // An empty colorPalette is unrepresentable in a valid config (min 1), so
    // only refs and description have an empty case to pin.
    const styles = [
      makeStyle({
        id: 'a',
        name: 'Alpha',
        description: null,
        config: {
          mood: 'tense',
          artStyle: 'noir',
          lighting: 'hard',
          colorPalette: ['#111'],
          cameraWork: 'static',
          referenceFilms: [],
          colorGrading: 'desaturated',
        },
      }),
    ];

    const { catalog } = buildStyleCatalog(styles);

    expect(catalog).toContain('[0] Alpha — mood: tense');
    expect(catalog).toContain('popularity: 0');
    expect(catalog).not.toContain('refs:');
    // No dangling " · " from the dropped description/array fields.
    expect(catalog).not.toContain('—  ·');
  });

  it('caps palette at 6 and reference films at 4', () => {
    const styles = [
      makeStyle({
        id: 'a',
        name: 'Alpha',
        config: {
          mood: 'epic',
          artStyle: 'painterly',
          lighting: 'golden',
          colorPalette: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'],
          cameraWork: 'sweeping',
          referenceFilms: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
          colorGrading: 'warm',
        },
      }),
    ];

    const { catalog } = buildStyleCatalog(styles);

    expect(catalog).toContain('palette: c1, c2, c3, c4, c5, c6');
    expect(catalog).not.toContain('c7');
    expect(catalog).toContain('refs: f1, f2, f3, f4');
    expect(catalog).not.toContain('f5');
  });

  it('carries popularity and truncates an overlong description', () => {
    const longDescription = 'x'.repeat(500);
    const styles = [
      makeStyle({
        id: 'a',
        name: 'Alpha',
        description: longDescription,
        usageCount: 42,
      }),
    ];

    const { catalog } = buildStyleCatalog(styles);

    expect(catalog).toContain('popularity: 42');
    // Truncated to 200 chars + ellipsis, never the full 500.
    expect(catalog).toContain('…');
    expect(catalog).not.toContain(longDescription);
  });
});

describe('rankStyleRecommendations', () => {
  const styles = [
    makeStyle({ id: 'a', usageCount: 5 }),
    makeStyle({ id: 'b', usageCount: 50 }),
    makeStyle({ id: 'c', usageCount: 1 }),
  ];
  const ordered = ['a', 'b', 'c'];

  it('maps indices back to style ids', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 2, score: 90, reasoning: 'fits c' },
          { index: 0, score: 80, reasoning: 'fits a' },
        ],
      },
      ordered,
      styles,
      5
    );

    expect(result).toEqual([
      { styleId: 'c', score: 90, reasoning: 'fits c' },
      { styleId: 'a', score: 80, reasoning: 'fits a' },
    ]);
  });

  it('sorts by score descending regardless of returned order', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 0, score: 30, reasoning: '' },
          { index: 1, score: 95, reasoning: '' },
          { index: 2, score: 60, reasoning: '' },
        ],
      },
      ordered,
      styles,
      5
    );

    expect(result.map((r) => r.styleId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks score ties by higher usage count', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 0, score: 70, reasoning: '' }, // usage 5
          { index: 1, score: 70, reasoning: '' }, // usage 50
          { index: 2, score: 70, reasoning: '' }, // usage 1
        ],
      },
      ordered,
      styles,
      5
    );

    expect(result.map((r) => r.styleId)).toEqual(['b', 'a', 'c']);
  });

  it('drops out-of-range, negative, and non-integer indices', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 99, score: 100, reasoning: 'hallucinated' },
          { index: -1, score: 100, reasoning: 'negative' },
          { index: 1.5, score: 100, reasoning: 'fractional' },
          { index: 1, score: 50, reasoning: 'valid' },
        ],
      },
      ordered,
      styles,
      5
    );

    expect(result).toEqual([{ styleId: 'b', score: 50, reasoning: 'valid' }]);
  });

  it('dedupes repeated styles, keeping the highest-scoring occurrence', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 0, score: 40, reasoning: 'low' },
          { index: 0, score: 90, reasoning: 'high' },
        ],
      },
      ordered,
      styles,
      5
    );

    expect(result).toEqual([{ styleId: 'a', score: 90, reasoning: 'high' }]);
  });

  it('returns an empty list for no recommendations', () => {
    expect(
      rankStyleRecommendations({ recommendations: [] }, ordered, styles, 5)
    ).toEqual([]);
  });

  it('returns an empty list when every index is unusable', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 99, score: 100, reasoning: 'out of range' },
          { index: -1, score: 100, reasoning: 'negative' },
          { index: 2.5, score: 100, reasoning: 'fractional' },
        ],
      },
      ordered,
      styles,
      5
    );

    expect(result).toEqual([]);
  });

  it('respects the limit', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [
          { index: 0, score: 30, reasoning: '' },
          { index: 1, score: 90, reasoning: '' },
          { index: 2, score: 60, reasoning: '' },
        ],
      },
      ordered,
      styles,
      2
    );

    expect(result.map((r) => r.styleId)).toEqual(['b', 'c']);
  });

  it('trims reasoning whitespace', () => {
    const result = rankStyleRecommendations(
      {
        recommendations: [{ index: 0, score: 50, reasoning: '  spaced  ' }],
      },
      ordered,
      styles,
      5
    );

    expect(result[0]?.reasoning).toBe('spaced');
  });
});
