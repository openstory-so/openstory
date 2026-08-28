import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { describe, expect, it } from 'vitest';
import { buildStyledImagePrompt } from './style-image-prompt';

const config = migrateStyleConfigV1ToV2({
  mood: 'playful',
  artStyle: 'layered paper pop-up cutouts',
  lighting: 'soft daylight',
  colorPalette: ['#fff'],
  cameraWork: 'slow push-in',
  referenceFilms: ['handmade stop-motion clay shorts'],
  colorGrading: 'warm',
});

describe('buildStyledImagePrompt', () => {
  it('puts the scene first as the subject and folds in the style config', () => {
    const prompt = buildStyledImagePrompt('a child reads in a meadow', config);
    expect(prompt).toContain('a child reads in a meadow');
    expect(prompt).toContain('layered paper pop-up cutouts');
    expect(prompt).toContain('handmade stop-motion clay shorts');
  });

  it('guards against literal-medium / multi-frame renders', () => {
    const prompt = buildStyledImagePrompt('a scene', config);
    expect(prompt).toContain('single full-frame image only');
    expect(prompt).toMatch(/do not depict the medium/i);
    expect(prompt).toMatch(/no grid, no panels/i);
  });

  it('never injects a bare style name (only the "Art Style" treatment)', () => {
    // The old preview prompt joined a `. Style: <name>` segment, which made the
    // model render medium-named styles literally. The builder takes no name.
    const prompt = buildStyledImagePrompt('a scene', config);
    expect(prompt).not.toContain('. Style:');
  });
});
