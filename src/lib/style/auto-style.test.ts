import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AUTO_STYLE_PLACEHOLDER_NAME,
  DEFAULT_AUTO_STYLE_CATEGORY,
  STYLE_CATEGORIES,
  autoStyleResponseSchema,
  type AutoStyleResponse,
  autoStyleDraftFromResponse,
  placeholderAutoStyleDraft,
} from './auto-style';
import { StyleConfigSchema } from './style-config';

const RESPONSE: AutoStyleResponse = {
  name: 'Rain-slick Neon Noir',
  description: 'Wet streets, sodium and neon, patient camera.',
  category: 'film',
  tags: ['noir', 'neon', 'night'],
  mood: 'tense and paranoid',
  artStyle: 'high-contrast photorealism',
  medium: '35mm anamorphic',
  lighting: 'practical neon and sodium vapour, hard shadows',
  colorPalette: ['#0a0a14', '#e8322f', ' ', '#2bd1ff'],
  colorGrading: 'crushed blacks, teal shadows',
  camera: 'slow dollies, static wides',
  shots: 'wide establishing, tight inserts',
  pace: 'measured',
  energy: 7.4,
  references: ['rain-slicked neon-noir cityscapes', ''],
};

describe('autoStyleDraftFromResponse', () => {
  it('builds a valid v2 config and row fields', () => {
    const draft = autoStyleDraftFromResponse(RESPONSE);
    expect(() => StyleConfigSchema.parse(draft.config)).not.toThrow();
    expect(draft.name).toBe('Rain-slick Neon Noir');
    expect(draft.category).toBe('film');
    expect(draft.tags).toEqual(['noir', 'neon', 'night']);
    expect(draft.config.look.colorPalette).toEqual([
      '#0a0a14',
      '#e8322f',
      '#2bd1ff',
    ]);
    expect(draft.config.references).toEqual([
      'rain-slicked neon-noir cityscapes',
    ]);
    expect(draft.config.look.medium).toBe('35mm anamorphic');
    expect(draft.config.motion.shots).toBe('wide establishing, tight inserts');
  });

  it('clamps energy into 1–5 and rounds it', () => {
    expect(autoStyleDraftFromResponse(RESPONSE).config.motion.energy).toBe(5);
    expect(
      autoStyleDraftFromResponse({ ...RESPONSE, energy: 0.2 }).config.motion
        .energy
    ).toBe(1);
    expect(
      autoStyleDraftFromResponse({ ...RESPONSE, energy: 2.6 }).config.motion
        .energy
    ).toBe(3);
  });

  it('drops blank optional refinements instead of storing empty strings', () => {
    const draft = autoStyleDraftFromResponse({
      ...RESPONSE,
      medium: '  ',
      shots: '',
      description: ' ',
    });
    expect(draft.config.look.medium).toBeUndefined();
    expect(draft.config.motion.shots).toBeUndefined();
    expect(draft.description).toBeNull();
  });

  it('throws on an unsalvageable answer (empty palette, blank name, terse prose)', () => {
    expect(() =>
      autoStyleDraftFromResponse({ ...RESPONSE, colorPalette: [' '] })
    ).toThrow();
    expect(() =>
      autoStyleDraftFromResponse({ ...RESPONSE, name: '  ' })
    ).toThrow();
    expect(() =>
      autoStyleDraftFromResponse({ ...RESPONSE, mood: 'ok' })
    ).toThrow();
  });
});

describe('placeholderAutoStyleDraft', () => {
  it('is a valid config with the placeholder name', () => {
    const draft = placeholderAutoStyleDraft();
    expect(draft.name).toBe(AUTO_STYLE_PLACEHOLDER_NAME);
    expect(() => StyleConfigSchema.parse(draft.config)).not.toThrow();
  });
});

describe('autoStyleResponseSchema vocabulary guesses (#1285)', () => {
  it('defaults an off-vocabulary category/pace instead of failing the parse', () => {
    const parsed = autoStyleResponseSchema.parse({
      ...RESPONSE,
      category: 'Documentary',
      pace: 'rapid',
    });
    expect(parsed.category).toBe(DEFAULT_AUTO_STYLE_CATEGORY);
    expect(parsed.pace).toBe('measured');
    expect(autoStyleResponseSchema.parse(RESPONSE).category).toBe('film');
    const draft = autoStyleDraftFromResponse(parsed);
    expect(StyleConfigSchema.safeParse(draft.config).success).toBe(true);
  });

  it('still sends the enum to the provider', () => {
    const json = z.toJSONSchema(autoStyleResponseSchema);
    expect(json.properties?.category).toMatchObject({
      enum: [...STYLE_CATEGORIES],
      default: DEFAULT_AUTO_STYLE_CATEGORY,
    });
  });
});
