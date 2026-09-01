import { describe, expect, it } from 'vitest';
import { getMotionReferenceEndpoint } from '@/lib/ai/models';
import type { MotionReferenceEndpointConfig } from '@/lib/ai/models';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildReferenceVideoPrompt } from './build-reference-video-prompt';

const STILL = 'https://example.com/still.png';

const seedanceV2Config = getMotionReferenceEndpoint('seedance_v2');
if (!seedanceV2Config) {
  throw new Error('seedance_v2 must have a 2.0 reference endpoint config');
}
const seedanceV25Config = getMotionReferenceEndpoint('seedance_v2_5');
if (!seedanceV25Config) {
  throw new Error('seedance_v2_5 must have a 2.5 reference endpoint config');
}

const ref = (
  url: string,
  description: string,
  token?: string
): ReferenceImageDescription => ({
  referenceImageUrl: url,
  description,
  role: 'character',
  token,
});

describe.each([
  ['seedance_v2', seedanceV2Config] as const,
  ['seedance_v2_5', seedanceV25Config] as const,
])(
  'buildReferenceVideoPrompt (%s)',
  (_model, seedanceConfig: MotionReferenceEndpointConfig) => {
    it('declares the still as the starting frame on the first line', () => {
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'A slow dolly in',
        STILL,
        []
      );
      expect(
        result.prompt.startsWith('Use @Image1 as the starting frame.\n')
      ).toBe(true);
      expect(result.imageUrls).toEqual([STILL]);
    });

    it('binds mentioned tokens inline as @ImageN instead of a legend', () => {
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'ALICE turns toward the window as the CORAL_LIPSTICK glints',
        STILL,
        [
          ref('https://example.com/a.png', 'Alice - tall woman', 'Alice'),
          ref(
            'https://example.com/b.png',
            'CORAL_LIPSTICK - a coral tube',
            'CORAL_LIPSTICK'
          ),
        ]
      );
      expect(result.imageUrls).toEqual([
        STILL,
        'https://example.com/a.png',
        'https://example.com/b.png',
      ]);
      expect(result.prompt).toContain(
        '@Image2 turns toward the window as the @Image3 glints'
      );
      expect(result.prompt).not.toContain('Reference images:');
    });

    it('matches tokens case-insensitively and word-bounded', () => {
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'Scarlett adjusts her jacket',
        STILL,
        [
          ref('https://example.com/a.png', 'Scarlett - athletic', 'Scarlett'),
          ref('https://example.com/b.png', 'Jack - tall man', 'Jack'),
        ]
      );
      // "Scarlett" bound inline; "jacket" must NOT match token "Jack".
      expect(result.prompt).toContain('@Image2 adjusts her jacket');
      expect(result.prompt).toContain('@Image3: Jack - tall man');
    });

    it('omits the legend when skipLegend is set', () => {
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'A slow dolly in',
        STILL,
        [ref('https://example.com/a.png', 'Alice - tall woman', 'Alice')],
        undefined,
        { skipLegend: true }
      );
      expect(result.prompt).not.toContain('Reference images:');
      expect(result.prompt).not.toContain('@Image2:');
      expect(result.imageUrls).toEqual([STILL, 'https://example.com/a.png']);
    });

    it('falls back to a legend line for refs never mentioned in the prompt', () => {
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'A slow dolly in',
        STILL,
        [ref('https://example.com/a.png', 'Alice - tall woman', 'Alice')]
      );
      expect(result.prompt).toContain('Reference images:');
      expect(result.prompt).toContain(
        '@Image2: Alice - tall woman — keep visually consistent throughout the shot.'
      );
    });

    it('drops references with no URL', () => {
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'A slow dolly in',
        STILL,
        [
          ref('', 'No image', 'GHOST'),
          ref('https://example.com/b.png', 'Bob - short man', 'Bob'),
        ]
      );
      expect(result.imageUrls).toEqual([STILL, 'https://example.com/b.png']);
      expect(result.prompt).toContain('@Image2: Bob - short man');
      expect(result.prompt).not.toContain('No image');
    });

    it('caps attached images at maxImages and substitutes overflow tokens with descriptions', () => {
      const refs = Array.from({ length: 10 }, (_, i) =>
        ref(
          `https://example.com/${i}.png`,
          `Ref ${i} - person ${i}`,
          `REF_${i}`
        )
      );
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        'REF_0 waves while REF_9 walks away',
        STILL,
        refs
      );
      // still + 8 refs = 9 images; REF_8 and REF_9 overflow.
      expect(result.imageUrls).toHaveLength(9);
      expect(result.imageUrls[0]).toBe(STILL);
      // Attached + mentioned → inline tag; overflow + mentioned → description.
      expect(result.prompt).toContain('@Image2 waves');
      expect(result.prompt).toContain('Ref 9 (person 9) walks away');
      expect(result.prompt).not.toContain('@Image10');
    });

    it('truncates the base prompt (never the legend or start line) to fit the limit', () => {
      const longBase = 'x'.repeat(5000);
      const result = buildReferenceVideoPrompt(
        seedanceConfig,
        longBase,
        STILL,
        [ref('https://example.com/a.png', 'Alice - tall woman', 'Alice')],
        2500
      );
      expect(result.prompt.length).toBeLessThanOrEqual(2500);
      expect(
        result.prompt.startsWith('Use @Image1 as the starting frame.')
      ).toBe(true);
      expect(result.prompt).toContain('@Image2: Alice - tall woman');
      expect(result.prompt).toContain('...');
    });
  }
);

describe('buildReferenceVideoPrompt (minimax_h3_max)', () => {
  const h3Config = getMotionReferenceEndpoint('minimax_h3_max');
  if (!h3Config) {
    throw new Error('minimax_h3_max must have a reference endpoint config');
  }

  it('uses spaced Image N tokens, not @ImageN', () => {
    const result = buildReferenceVideoPrompt(
      h3Config,
      'ALICE turns toward the window',
      STILL,
      [ref('https://example.com/a.png', 'Alice - tall woman', 'Alice')]
    );
    expect(
      result.prompt.startsWith('Use Image 1 as the starting frame.\n')
    ).toBe(true);
    expect(result.prompt).toContain('Image 2 turns toward the window');
    expect(result.prompt).not.toContain('@Image');
  });
});

describe('buildReferenceVideoPrompt (per-model config knobs)', () => {
  // Gemini Omni Flash-style config: 0-indexed angle-bracket tags, tighter cap.
  const omniStyleConfig: MotionReferenceEndpointConfig = {
    endpointId: 'google/gemini-omni-flash/reference-to-video',
    tag: (position) => `<IMAGE_REF_${position - 1}>`,
    maxImages: 4,
  };

  it('renders the model-specific tag syntax inline and in the start line', () => {
    const result = buildReferenceVideoPrompt(
      omniStyleConfig,
      'ALICE waves at the camera',
      STILL,
      [ref('https://example.com/a.png', 'Alice - tall woman', 'Alice')]
    );
    expect(
      result.prompt.startsWith('Use <IMAGE_REF_0> as the starting frame.')
    ).toBe(true);
    expect(result.prompt).toContain('<IMAGE_REF_1> waves at the camera');
    expect(result.prompt).not.toContain('@Image');
  });

  it('caps total images at the config maxImages', () => {
    const refs = Array.from({ length: 6 }, (_, i) =>
      ref(`https://example.com/${i}.png`, `Ref ${i} - person ${i}`, `REF_${i}`)
    );
    const result = buildReferenceVideoPrompt(
      omniStyleConfig,
      'A slow dolly in',
      STILL,
      refs
    );
    expect(result.imageUrls).toHaveLength(4);
    expect(result.prompt).toContain('<IMAGE_REF_3>: Ref 2 - person 2');
    expect(result.prompt).not.toContain('<IMAGE_REF_4>');
  });

  it('tags Grok Imagine 1.5 refs as <IMAGE_0>… in request order', () => {
    const grokConfig: MotionReferenceEndpointConfig = {
      endpointId: 'grok-imagine-video-1.5',
      tag: (position) => `<IMAGE_${position - 1}>`,
      maxImages: 7,
    };
    const result = buildReferenceVideoPrompt(
      grokConfig,
      'SCARLETT lifts the CORAL_LIPSTICK',
      STILL,
      [
        ref('https://example.com/a.png', 'Scarlett - athletic', 'SCARLETT'),
        {
          referenceImageUrl: 'https://example.com/b.png',
          description: 'CORAL_LIPSTICK - a coral tube',
          role: 'element',
          token: 'CORAL_LIPSTICK',
        },
      ]
    );
    expect(
      result.prompt.startsWith('Use <IMAGE_0> as the starting frame.')
    ).toBe(true);
    expect(result.prompt).toContain('<IMAGE_1> lifts the <IMAGE_2>');
    expect(result.imageUrls).toEqual([
      STILL,
      'https://example.com/a.png',
      'https://example.com/b.png',
    ]);
  });
});
