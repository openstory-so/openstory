import { describe, expect, it } from 'vitest';
import type { ReferenceImageDescription } from '@/shared/prompts/reference-image-prompt';
import { buildKlingElementsInput } from './build-kling-elements';

const ref = (url: string, description: string): ReferenceImageDescription => ({
  referenceImageUrl: url,
  description,
  role: 'character',
});

describe('buildKlingElementsInput', () => {
  it('returns the base prompt unchanged when there are no references', () => {
    const result = buildKlingElementsInput('A slow dolly in', []);
    expect(result).toEqual({ prompt: 'A slow dolly in', elements: [] });
  });

  it('maps each reference to a frontal + reference image element in order', () => {
    const result = buildKlingElementsInput('A slow dolly in', [
      ref('https://example.com/a.png', 'Alice'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    // fal requires both fields on an image-set element; we only have one
    // image per reference, so it fills both.
    expect(result.elements).toEqual([
      {
        frontal_image_url: 'https://example.com/a.png',
        reference_image_urls: ['https://example.com/a.png'],
      },
      {
        frontal_image_url: 'https://example.com/b.png',
        reference_image_urls: ['https://example.com/b.png'],
      },
    ]);
  });

  it('appends an @ElementN legend numbered to match element order', () => {
    const result = buildKlingElementsInput('A slow dolly in', [
      ref('https://example.com/a.png', 'Alice'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.prompt).toContain('A slow dolly in');
    expect(result.prompt).toContain('@Element1: Alice');
    expect(result.prompt).toContain('@Element2: Bob');
  });

  it('drops references with no URL', () => {
    const result = buildKlingElementsInput('A slow dolly in', [
      ref('', 'No image'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.elements).toEqual([
      {
        frontal_image_url: 'https://example.com/b.png',
        reference_image_urls: ['https://example.com/b.png'],
      },
    ]);
    expect(result.prompt).toContain('@Element1: Bob');
    expect(result.prompt).not.toContain('No image');
  });

  it('caps the elements array at 4 (fal limit)', () => {
    const refs = Array.from({ length: 6 }, (_, i) =>
      ref(`https://example.com/${i}.png`, `Ref ${i}`)
    );
    const result = buildKlingElementsInput('A slow dolly in', refs);
    expect(result.elements).toHaveLength(4);
    expect(result.prompt).toContain('@Element4: Ref 3');
    expect(result.prompt).not.toContain('@Element5');
  });

  it('truncates the base prompt (never the legend) to fit the limit', () => {
    const longBase = 'x'.repeat(5000);
    const refs = [ref('https://example.com/a.png', 'Alice')];
    const result = buildKlingElementsInput(longBase, refs, 2500);
    expect(result.prompt.length).toBeLessThanOrEqual(2500);
    // The legend is load-bearing — it must survive truncation in full.
    expect(result.prompt).toContain('@Element1: Alice');
    expect(result.prompt).toContain('...');
  });

  it('binds mentioned tokens inline as @ElementN with no legend', () => {
    const result = buildKlingElementsInput(
      'ALICE lifts the CORAL_LIPSTICK toward the light',
      [
        {
          ...ref('https://example.com/a.png', 'Alice - tall woman'),
          token: 'Alice',
        },
        {
          ...ref('https://example.com/b.png', 'CORAL_LIPSTICK - a coral tube'),
          token: 'CORAL_LIPSTICK',
        },
      ]
    );
    expect(result.prompt).toBe(
      '@Element1 lifts the @Element2 toward the light'
    );
  });

  it('legends only the unmentioned refs when others bind inline', () => {
    const result = buildKlingElementsInput('ALICE walks out of frame', [
      {
        ...ref('https://example.com/a.png', 'Alice - tall woman'),
        token: 'Alice',
      },
      {
        ...ref('https://example.com/b.png', 'Bob - short man'),
        token: 'Bob',
      },
    ]);
    expect(result.prompt).toContain('@Element1 walks out of frame');
    expect(result.prompt).not.toContain('@Element1: Alice');
    expect(result.prompt).toContain('@Element2: Bob - short man');
  });

  it('substitutes overflow (5th+) ref tokens with descriptions', () => {
    const refs = Array.from({ length: 5 }, (_, i) => ({
      ...ref(`https://example.com/${i}.png`, `Ref ${i} - person ${i}`),
      token: `REF_${i}`,
    }));
    const result = buildKlingElementsInput(
      'REF_0 nods while REF_4 exits',
      refs
    );
    expect(result.elements).toHaveLength(4);
    expect(result.prompt).toContain('@Element1 nods');
    expect(result.prompt).toContain('Ref 4 (person 4) exits');
  });
});
