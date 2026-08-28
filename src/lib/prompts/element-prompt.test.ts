import { describe, expect, test } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { StyleConfig } from '@/lib/db/schema';
import {
  buildElementDescription,
  buildElementSheetPrompt,
} from './element-prompt';

const entry: ElementBibleEntry = {
  token: 'CORAL_LIPSTICK',
  description:
    'A slim cylindrical lipstick in a matte white case with a coral accent band, the bullet a creamy warm coral with a flat sheen',
  consistencyTag: 'coral-lipstick-white-case',
  firstMention: {
    sceneId: 'scene_1',
    text: 'She lifts a matte white box, fingers tracing the coral accent.',
    lineNumber: 5,
  },
};

const styleConfig: StyleConfig = migrateStyleConfigV1ToV2({
  mood: 'sun-drenched optimism',
  artStyle: 'cinematic photorealism',
  lighting: 'warm golden-hour natural light',
  colorPalette: ['coral', 'sand', 'sea foam'],
  cameraWork: 'handheld intimate',
  referenceFilms: ['Call Me by Your Name'],
  colorGrading: 'warm highlights, soft teal shadows',
});

describe('buildElementSheetPrompt', () => {
  test('embeds the bible description and consistency tag', () => {
    const prompt = buildElementSheetPrompt(entry);

    expect(prompt).toContain(entry.description);
    expect(prompt).toContain(entry.consistencyTag);
  });

  test('defaults to a neutral studio look without a style config', () => {
    const prompt = buildElementSheetPrompt(entry);

    expect(prompt).toContain('commercial photo studio cyclorama');
    expect(prompt).toContain('5500K daylight balance');
  });

  test('applies the sequence style when provided', () => {
    const prompt = buildElementSheetPrompt(entry, styleConfig);

    expect(prompt).toContain('cinematic photorealism');
    expect(prompt).toContain('coral, sand, sea foam');
    expect(prompt).toContain('warm golden-hour natural light');
    expect(prompt).toContain('warm highlights, soft teal shadows');
    expect(prompt).not.toContain('5500K daylight balance');
  });

  test('keeps people and props out of the reference shot', () => {
    const prompt = buildElementSheetPrompt(entry, styleConfig);

    expect(prompt).toContain('No hands, no people, no props');
  });
});

describe('buildElementDescription', () => {
  test('prefixes token and trims description to its first clause', () => {
    const result = buildElementDescription({
      id: 'el_1',
      token: 'CORAL_LIPSTICK',
      description: entry.description,
      imageUrl: 'https://example.com/el.png',
      consistencyTag: entry.consistencyTag,
    });

    expect(result).toBe(
      'CORAL_LIPSTICK - A slim cylindrical lipstick in a matte white case with a coral accent band'
    );
  });
});
