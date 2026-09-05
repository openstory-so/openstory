import { describe, expect, it } from 'vitest';
import {
  buildReferenceImagePrompt,
  type ReferenceImageDescription,
} from './reference-image-prompt';

const ref = (
  overrides: Partial<ReferenceImageDescription> &
    Pick<ReferenceImageDescription, 'referenceImageUrl' | 'description'>
): ReferenceImageDescription => overrides;

describe('buildReferenceImagePrompt', () => {
  it('returns the base prompt unchanged when there are no references', () => {
    const result = buildReferenceImagePrompt('A quiet beach at dawn', []);
    expect(result).toEqual({
      prompt: 'A quiet beach at dawn',
      referenceUrls: [],
    });
  });

  it('binds mentioned tokens inline with (Image N) and skips their legend lines', () => {
    const result = buildReferenceImagePrompt(
      'SCARLETT lifts the CORAL_LIPSTICK toward the light',
      [
        ref({
          referenceImageUrl: 'https://example.com/scarlett.png',
          description: 'Scarlett',
          role: 'character',
          token: 'Scarlett',
        }),
        ref({
          referenceImageUrl: 'https://example.com/lipstick.png',
          description: 'CORAL_LIPSTICK - a coral tube',
          role: 'element',
          token: 'CORAL_LIPSTICK',
        }),
      ]
    );
    expect(result.prompt).toContain(
      'Scarlett (Image 1) lifts the CORAL_LIPSTICK (Image 2) toward the light'
    );
    expect(result.prompt).not.toContain('Image 1 (character)');
    expect(result.prompt).not.toContain('Image 2 (element)');
    // The identity guard always accompanies references.
    expect(result.prompt).toContain('Reference images define identity');
  });

  it('orders references primary → characters → locations → elements and numbers accordingly', () => {
    const result = buildReferenceImagePrompt('A scene with SCARLETT', [
      ref({
        referenceImageUrl: 'https://example.com/loc.png',
        description: 'INT. BONDI STUDIO - MORNING',
        role: 'location',
      }),
      ref({
        referenceImageUrl: 'https://example.com/scarlett.png',
        description: 'Scarlett',
        role: 'character',
        token: 'Scarlett',
      }),
      ref({
        referenceImageUrl: 'https://example.com/primary.png',
        description: 'Primary source scene',
        role: 'primary',
      }),
    ]);
    expect(result.referenceUrls).toEqual([
      'https://example.com/primary.png',
      'https://example.com/scarlett.png',
      'https://example.com/loc.png',
    ]);
    expect(result.prompt).toContain('Scarlett (Image 2)');
    expect(result.prompt).toContain('Image 1 (primary): Primary source scene');
    expect(result.prompt).toContain(
      'Image 3 (location): INT. BONDI STUDIO - MORNING'
    );
  });

  it('legends unmentioned refs and never inline-binds the primary', () => {
    const result = buildReferenceImagePrompt('A hand reaches for the tube', [
      ref({
        referenceImageUrl: 'https://example.com/primary.png',
        description: 'Primary source scene',
        role: 'primary',
        token: 'hand', // even a pathological token on the primary is ignored
      }),
      ref({
        referenceImageUrl: 'https://example.com/bob.png',
        description: 'Bob - short man',
        role: 'character',
        token: 'Bob',
      }),
    ]);
    expect(result.prompt).toContain('A hand reaches for the tube');
    expect(result.prompt).toContain('Image 1 (primary): Primary source scene');
    expect(result.prompt).toContain('Image 2 (character): Bob - short man');
  });

  it('strips a legacy <reference-images> block before enhancing', () => {
    const stored = `A scene with SCARLETT

  <reference-images>
    - Image 1 [CHARACTER REF]: Scarlett - old description
    IMPORTANT: old instructions
  </reference-images>`;
    const result = buildReferenceImagePrompt(stored, [
      ref({
        referenceImageUrl: 'https://example.com/scarlett.png',
        description: 'Scarlett',
        role: 'character',
        token: 'Scarlett',
      }),
    ]);
    expect(result.prompt).not.toContain('CHARACTER REF');
    expect(result.prompt).not.toContain('old description');
    expect(result.prompt).toContain('Scarlett (Image 1)');
  });

  it('is idempotent: re-enhancing an already-enhanced prompt does not double-bind', () => {
    const first = buildReferenceImagePrompt('SCARLETT walks out of frame', [
      ref({
        referenceImageUrl: 'https://example.com/scarlett.png',
        description: 'Scarlett',
        role: 'character',
        token: 'Scarlett',
      }),
    ]);
    const second = buildReferenceImagePrompt(first.prompt, [
      ref({
        referenceImageUrl: 'https://example.com/scarlett.png',
        description: 'Scarlett',
        role: 'character',
        token: 'Scarlett',
      }),
    ]);
    expect(second.prompt).toBe(first.prompt);
    expect(second.prompt).not.toContain('(Image 1) (Image 1)');
  });

  it('truncates the base prompt (never the legend) to fit the limit', () => {
    const longBase = 'x'.repeat(5000);
    const result = buildReferenceImagePrompt(
      longBase,
      [
        ref({
          referenceImageUrl: 'https://example.com/loc.png',
          description: 'INT. BONDI STUDIO - MORNING',
          role: 'location',
        }),
      ],
      2500
    );
    expect(result.prompt.length).toBeLessThanOrEqual(2500);
    expect(result.prompt).toContain(
      'Image 1 (location): INT. BONDI STUDIO - MORNING'
    );
    expect(result.prompt).toContain('...');
  });
});
