import { describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog';
import {
  compareVersionsDesc,
  groupModelsIntoFamilies,
  splitEndpointId,
} from './model-families';

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    endpointId: 'fal-ai/flux-1/dev',
    displayName: 'FLUX.1 [dev]',
    activity: 'image',
    ...overrides,
  };
}

describe('splitEndpointId', () => {
  it.each([
    // The fal-ai/ platform prefix is canonicalized away.
    [
      'fal-ai/kling-video/v2.6/pro/image-to-video',
      {
        familyPath: 'kling-video',
        version: 'v2.6',
        variantLabel: 'pro/image-to-video',
      },
    ],
    [
      'fal-ai/kling-video/o3/4k/image-to-video',
      {
        familyPath: 'kling-video',
        version: 'o3',
        variantLabel: '4k/image-to-video',
      },
    ],
    // Same brand under both roots lands on the same family path.
    [
      'fal-ai/ideogram/v3/edit',
      { familyPath: 'ideogram', version: 'v3', variantLabel: 'edit' },
    ],
    [
      'ideogram/v4/fast',
      { familyPath: 'ideogram', version: 'v4', variantLabel: 'fast' },
    ],
    // Letter-suffixed versions are versions.
    [
      'fal-ai/ideogram/v2a/turbo',
      { familyPath: 'ideogram', version: 'v2a', variantLabel: 'turbo' },
    ],
    // Version embedded in a segment, optionally with a trailing modifier.
    [
      'fal-ai/veo3/fast/image-to-video',
      { familyPath: 'veo', version: 'v3', variantLabel: 'fast/image-to-video' },
    ],
    [
      'bytedance/seedance-2.0/fast/image-to-video',
      {
        familyPath: 'bytedance/seedance',
        version: 'v2.0',
        variantLabel: 'fast/image-to-video',
      },
    ],
    [
      'fal-ai/flux-1/dev',
      { familyPath: 'flux', version: 'v1', variantLabel: 'dev' },
    ],
    [
      'fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video',
      {
        familyPath: 'minimax/hailuo',
        version: 'v2.3-fast',
        variantLabel: 'pro/image-to-video',
      },
    ],
    [
      'fal-ai/minimax/video-01-live/image-to-video',
      {
        familyPath: 'minimax/video',
        version: 'v01-live',
        variantLabel: 'image-to-video',
      },
    ],
    [
      'fal-ai/mmaudio-v2/text-to-audio',
      { familyPath: 'mmaudio', version: 'v2', variantLabel: 'text-to-audio' },
    ],
    // Size suffixes and digit-leading modifiers stay with the version.
    [
      'fal-ai/wan-vace-14b/depth',
      { familyPath: 'wan-vace', version: 'v14b', variantLabel: 'depth' },
    ],
    [
      'fal-ai/ltx-2.3-22b/distilled',
      { familyPath: 'ltx', version: 'v2.3-22b', variantLabel: 'distilled' },
    ],
    // Dotless two-digit versions read as major.minor.
    [
      'fal-ai/wan-25-preview/image-to-video',
      {
        familyPath: 'wan',
        version: 'v2.5-preview',
        variantLabel: 'image-to-video',
      },
    ],
    // Standalone version right after the brand.
    [
      'wan/v2.6/image-to-video',
      { familyPath: 'wan', version: 'v2.6', variantLabel: 'image-to-video' },
    ],
    // Sub-products split at THEIR version segment.
    [
      'fal-ai/kling-video/ai-avatar/v2/pro',
      {
        familyPath: 'kling-video/ai-avatar',
        version: 'v2',
        variantLabel: 'pro',
      },
    ],
    // Mode abbreviations are not versions.
    [
      'fal-ai/wan-i2v',
      { familyPath: 'wan-i2v', version: null, variantLabel: '' },
    ],
    // A mode second segment is a variant of the line before it.
    [
      'fal-ai/wan-pro/image-to-video',
      { familyPath: 'wan-pro', version: null, variantLabel: 'image-to-video' },
    ],
    [
      'fal-ai/boogu-image/edit',
      { familyPath: 'boogu-image', version: null, variantLabel: 'edit' },
    ],
    // No version anywhere: brand + line is the family.
    [
      'bria/video/erase/mask',
      { familyPath: 'bria/video', version: null, variantLabel: 'erase/mask' },
    ],
    [
      'cassetteai/music-generator',
      {
        familyPath: 'cassetteai/music-generator',
        version: null,
        variantLabel: '',
      },
    ],
  ])('%s', (endpointId, expected) => {
    expect(splitEndpointId(endpointId)).toEqual(expected);
  });

  it('does not mistake resolutions for versions', () => {
    expect(splitEndpointId('vendor/line/4k/upscale')).toEqual({
      familyPath: 'vendor/line',
      version: null,
      variantLabel: '4k/upscale',
    });
    expect(splitEndpointId('vendor/line/720p')).toEqual({
      familyPath: 'vendor/line',
      version: null,
      variantLabel: '720p',
    });
  });
});

describe('compareVersionsDesc', () => {
  it('orders newest first, unversioned last', () => {
    const versions = ['v1.6', null, 'v3', 'o1', 'v2.5-turbo', 'v2.0', 'o3'];
    expect(versions.sort(compareVersionsDesc)).toEqual([
      'v3',
      'o3',
      'v2.5-turbo',
      'v2.0',
      'v1.6',
      'o1',
      null,
    ]);
  });

  it('sorts numerically, not lexically', () => {
    expect(compareVersionsDesc('v10', 'v9')).toBeLessThan(0);
    expect(compareVersionsDesc('v2.10', 'v2.9')).toBeLessThan(0);
  });

  it('reads leading-zero versions as sub-1.0 (v095 = 0.95)', () => {
    expect(compareVersionsDesc('v2.3', 'v095')).toBeLessThan(0);
    expect(compareVersionsDesc('v095', 'v09')).toBeLessThan(0);
  });

  it('ranks parameter sizes below real versions', () => {
    expect(compareVersionsDesc('v2.7', 'v14b')).toBeLessThan(0);
    expect(compareVersionsDesc('v095', 'v14b')).toBeLessThan(0);
    expect(compareVersionsDesc('v14b', null)).toBeLessThan(0);
  });
});

describe('groupModelsIntoFamilies', () => {
  it('groups versions of one product line into a single family, newest first', () => {
    const families = groupModelsIntoFamilies([
      model({
        endpointId: 'fal-ai/kling-video/v1.6/pro/image-to-video',
        displayName: 'Kling 1.6',
        activity: 'video',
      }),
      model({
        endpointId: 'fal-ai/kling-video/v3/pro/image-to-video',
        displayName: 'Kling Video',
        activity: 'video',
      }),
      model({
        endpointId: 'fal-ai/kling-video/v3/standard/image-to-video',
        displayName: 'Kling Video v3 Image to Video [Standard]',
        activity: 'video',
      }),
    ]);

    expect(families).toHaveLength(1);
    const family = families[0];
    expect(family?.family).toBe('kling-video');
    expect(family?.title).toBe('Kling Video');
    expect(family?.latestVersion).toBe('v3');
    expect(family?.representative.endpointId).toBe(
      'fal-ai/kling-video/v3/pro/image-to-video'
    );
    expect(family?.variants.map((v) => [v.version, v.variantLabel])).toEqual([
      ['v3', 'pro/image-to-video'],
      ['v3', 'standard/image-to-video'],
      ['v1.6', 'pro/image-to-video'],
    ]);
  });

  it('merges the same brand across the fal-ai/ prefix and bare roots', () => {
    const families = groupModelsIntoFamilies([
      model({
        endpointId: 'fal-ai/ideogram/v3',
        displayName: 'Ideogram Text to Image',
      }),
      model({
        endpointId: 'ideogram/v4',
        displayName: 'Ideogram V4.0 Text to Image',
      }),
    ]);

    expect(families).toHaveLength(1);
    expect(families[0]?.family).toBe('ideogram');
    expect(families[0]?.title).toBe('Ideogram');
    expect(families[0]?.latestVersion).toBe('v4');
  });

  it('merges modifier-suffixed versions into their line', () => {
    const families = groupModelsIntoFamilies([
      model({
        endpointId: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
        displayName: 'MiniMax Hailuo 02 [Pro] (Image to Video)',
        activity: 'video',
      }),
      model({
        endpointId: 'fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video',
        displayName: 'MiniMax Hailuo 2.3 Fast [Pro] (Image to Video)',
        activity: 'video',
      }),
    ]);

    expect(families).toHaveLength(1);
    expect(families[0]?.family).toBe('minimax/hailuo');
    expect(families[0]?.title).toBe('MiniMax Hailuo');
    expect(families[0]?.latestVersion).toBe('v2.3-fast');
  });

  it('folds sub-lines and aliases into an existing parent line', () => {
    const families = groupModelsIntoFamilies([
      model({
        endpointId: 'fal-ai/ltx-2.3-quality/text-to-video',
        displayName: 'Ltx 2.3 Quality',
        activity: 'video',
      }),
      model({
        endpointId: 'fal-ai/ltx-video/v095/image-to-video',
        displayName: 'LTX Video v0.9.5',
        activity: 'video',
      }),
      model({
        endpointId: 'fal-ai/ltxv-13b-098-distilled',
        displayName: 'LTX Video 13B Distilled',
        activity: 'video',
      }),
    ]);

    expect(families).toHaveLength(1);
    const family = families[0];
    expect(family?.family).toBe('ltx');
    // Real versions outrank leading-zero and size versions.
    expect(family?.latestVersion).toBe('v2.3-quality');
    expect(family?.variants.map((v) => [v.version, v.variantLabel])).toEqual([
      ['v2.3-quality', 'text-to-video'],
      ['v095', 'video/image-to-video'],
      ['v13b-098-distilled', ''],
    ]);
  });

  it('does not fold sub-lines when no parent line exists', () => {
    const families = groupModelsIntoFamilies([
      model({ endpointId: 'bria/video/erase/mask', activity: 'video' }),
      model({ endpointId: 'bria/genfill/v2' }),
    ]);

    // Different activities AND no bare "bria" family — both stand alone.
    expect(families).toHaveLength(2);
  });

  it('titles include the brand path with display-name casing', () => {
    const families = groupModelsIntoFamilies([
      model({
        endpointId: 'bria/video/erase/mask',
        displayName: 'Video',
        activity: 'video',
      }),
      model({
        endpointId: 'bria/video/background-removal',
        displayName: 'Video',
        activity: 'video',
      }),
      model({ endpointId: 'fal-ai/flux-1/dev', displayName: 'FLUX.1 [dev]' }),
    ]);

    expect(families.map((f) => f.title).sort()).toEqual(['Bria Video', 'FLUX']);
  });

  it('never groups across activities', () => {
    const families = groupModelsIntoFamilies([
      model({ endpointId: 'wan/v2/image', displayName: 'Wan Image' }),
      model({
        endpointId: 'wan/v2/video',
        displayName: 'Wan Video',
        activity: 'video',
      }),
    ]);

    expect(families).toHaveLength(2);
  });

  it('orders families by newest release, then variant count', () => {
    const families = groupModelsIntoFamilies([
      model({
        endpointId: 'vendor/duo/a',
        displayName: 'Duo A',
        firstSeenAt: 100,
      }),
      model({
        endpointId: 'vendor/duo/b',
        displayName: 'Duo B',
        firstSeenAt: 200,
      }),
      model({
        endpointId: 'vendor/fresh',
        displayName: 'Fresh',
        firstSeenAt: 300,
      }),
      model({ endpointId: 'vendor/undated', displayName: 'Undated' }),
    ]);

    expect(families.map((f) => f.family)).toEqual([
      'vendor/fresh', // newest firstSeenAt wins despite fewer variants
      'vendor/duo', // released 200 (its newest variant)
      'vendor/undated', // no date sorts last
    ]);
    expect(families[1]?.releasedAt).toBe(200);
  });
});
