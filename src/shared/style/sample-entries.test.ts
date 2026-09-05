import type { StyleSampleVideo } from '@/lib/db/schema/libraries';
import { generateMockStyles } from '@/shared/mocks/data-generators';
import { buildSampleEntries } from '@/shared/style/sample-entries';
import type { Style } from '@/types/database';
import { describe, expect, it } from 'vitest';

function makeStyle(over: Partial<Style>): Style {
  const [base] = generateMockStyles(1);
  if (!base) throw new Error('expected a mock style');
  return { ...base, ...over };
}

function sample(
  kind: StyleSampleVideo['kind'],
  order: number
): StyleSampleVideo {
  return {
    url: `https://assets.openstory.so/styles/x/${kind}.mp4`,
    kind,
    label: kind,
    durationSeconds: 15,
    order,
  };
}

describe('buildSampleEntries', () => {
  it('shows one entry per style, preferring the bespoke clip when present', () => {
    const styles = [
      makeStyle({
        id: 's1',
        name: 'Cinematic Noir',
        category: 'commercial',
        sampleVideos: [sample('canonical', 0), sample('bespoke', 1)],
      }),
    ];
    const entries = buildSampleEntries(styles);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.video.kind).toBe('bespoke');
    expect(entries[0]?.key).toBe('s1:bespoke');
    expect(entries[0]?.slug).toBe('cinematic-noir');
  });

  it('falls back to the canonical clip when there is no bespoke', () => {
    const styles = [
      makeStyle({
        id: 's1',
        category: 'commercial',
        sampleVideos: [sample('canonical', 0)],
      }),
    ];
    const entries = buildSampleEntries(styles);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.video.kind).toBe('canonical');
  });

  it('derives canonical.mp4 from previewUrl when sampleVideos is empty', () => {
    // PR-preview / fresh D1: system seed leaves sampleVideos empty.
    const styles = [
      makeStyle({
        id: 's1',
        name: 'Product Ad',
        category: 'commercial',
        sampleVideos: [],
        previewUrl:
          'https://assets.openstory.so/styles/product-ad/thumbnail.webp',
      }),
      makeStyle({
        id: 's2',
        category: 'commercial',
        sampleVideos: [],
        previewUrl: null,
      }),
    ];
    const entries = buildSampleEntries(styles);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.styleId).toBe('s1');
    expect(entries[0]?.video.kind).toBe('canonical');
    expect(entries[0]?.video.url).toBe(
      'https://assets.openstory.so/styles/product-ad/canonical.mp4'
    );
  });

  it('skips styles with no sample videos and no derivable asset folder', () => {
    const styles = [
      makeStyle({
        id: 's1',
        category: 'commercial',
        sampleVideos: [],
        previewUrl: null,
      }),
      makeStyle({
        id: 's2',
        category: 'commercial',
        sampleVideos: [sample('canonical', 0)],
      }),
    ];
    const entries = buildSampleEntries(styles);
    expect(entries.map((e) => e.styleId)).toEqual(['s2']);
  });

  it('derives aspect ratio from the style, defaulting to 16:9', () => {
    const styles = [
      makeStyle({
        id: 'p',
        category: 'commercial',
        defaultAspectRatio: '9:16',
        sampleVideos: [sample('canonical', 0)],
      }),
      makeStyle({
        id: 'd',
        category: 'commercial',
        defaultAspectRatio: null,
        sampleVideos: [sample('canonical', 0)],
      }),
    ];
    const entries = buildSampleEntries(styles);
    expect(entries.find((e) => e.styleId === 'p')?.aspectRatio).toBe('9:16');
    expect(entries.find((e) => e.styleId === 'd')?.aspectRatio).toBe('16:9');
  });

  it('flags hasBrief false for a style with no resolvable brief', () => {
    const withBrief = makeStyle({
      id: 'b',
      name: 'Some Commercial Style',
      category: 'commercial',
      sampleVideos: [sample('canonical', 0)],
    });
    const noBrief = makeStyle({
      id: 'n',
      name: 'Totally Unmapped Style Xyz',
      category: 'not-a-real-category',
      sampleVideos: [sample('canonical', 0)],
    });
    const entries = buildSampleEntries([withBrief, noBrief]);
    expect(entries.find((e) => e.styleId === 'b')?.hasBrief).toBe(true);
    expect(entries.find((e) => e.styleId === 'n')?.hasBrief).toBe(false);
  });
});
